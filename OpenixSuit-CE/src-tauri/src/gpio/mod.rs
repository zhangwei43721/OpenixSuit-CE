use crate::adb::adb_exec_shell;
use crate::efex::{efel_read_sync, efel_write_sync};
use crate::state::AppState;
use serde::Serialize;
use std::collections::HashMap;
use tauri::State;

#[derive(Serialize)]
pub struct PioPinState {
    pub index: u8,
    pub name: String,
    pub mux: u8,
    pub data: u8,
    pub drv: u8,
    pub pull: u8,
}

#[derive(Clone, Serialize)]
pub struct RuntimeGpioPin {
    pub pin_name: String,
    pub gpio_id: u32,
    pub function: String,
    pub mux: u8,
    pub pull: String,
    pub drv: String,
    pub data: String,
    pub functions: Vec<String>,
}

#[derive(Serialize)]
pub struct RuntimeGpioReport {
    pub chip: String,
    pub ports: Vec<RuntimeGpioPort>,
    pub pins: Vec<RuntimeGpioPin>,
}

/// Per-port result for the pinctrl runtime reader.
#[derive(Serialize)]
pub struct RuntimeGpioPort {
    pub port_name: String,
    pub port_index: u8,
    pub pins: Vec<RuntimeGpioPin>,
}

fn parse_pinconf_map(raw: &str) -> HashMap<String, String> {
    let mut conf_map: HashMap<String, String> = HashMap::new();
    for line in raw.lines() {
        if let (Some(s), Some(e)) = (line.find('('), line.find(')')) {
            let name = line[s + 1..e].trim().to_string();
            conf_map.insert(name, line[e + 1..].trim().to_string());
        }
    }
    conf_map
}

fn parse_pinmux_report(
    pinmux_raw: &str,
    conf_map: &HashMap<String, String>,
) -> Vec<RuntimeGpioPin> {
    let mut pins = Vec::new();
    for (idx, line) in pinmux_raw.lines().enumerate() {
        let trimmed = line.trim();
        if !trimmed.starts_with("pin ") {
            continue;
        }
        if let (Some(start), Some(end)) = (trimmed.find('('), trimmed.find(')')) {
            let pin_name = trimmed[start + 1..end].trim().to_string();
            let gpio_id = trimmed[4..start].trim().parse::<u32>().unwrap_or(idx as u32);
            let rest = trimmed[end + 1..].trim();

            let (function, mux, data) = if rest.contains("MUX UNCLAIMED") && rest.contains("GPIO UNCLAIMED") {
                ("IO_DISABLED".to_string(), 15u8, "FUNCTION".to_string())
            } else if let Some(pos) = rest.find("function ") {
                let func_name = rest[pos + 9..]
                    .split_whitespace()
                    .next()
                    .unwrap_or("FUNCTION")
                    .to_string();
                (func_name, 2u8, "FUNCTION".to_string())
            } else if !rest.contains("GPIO UNCLAIMED") {
                ("GPIO".to_string(), 1u8, "GPIO".to_string())
            } else {
                ("UNCLAIMED".to_string(), 0u8, "-".to_string())
            };

            let conf = conf_map.get(&pin_name).map(|s| s.as_str()).unwrap_or("");
            let pull = if conf.contains("pull up") {
                "Pull Up".into()
            } else if conf.contains("pull down") {
                "Pull Down".into()
            } else {
                "PULL DISABLE".into()
            };
            let drv = if let Some(dpos) = conf.find("drive strength") {
                conf[dpos..].split_whitespace().nth(2).unwrap_or("-").to_string()
            } else {
                "-".into()
            };

            pins.push(RuntimeGpioPin {
                pin_name,
                gpio_id,
                function,
                mux,
                pull,
                drv,
                data,
                functions: vec![
                    "(0): GPIO_IN".into(),
                    "(1): GPIO_OUT".into(),
                    "(15): IO_DISABLED".into(),
                ],
            });
        }
    }
    pins
}

fn group_pins_by_port(pins: Vec<RuntimeGpioPin>) -> Vec<RuntimeGpioPort> {
    let mut ports: Vec<RuntimeGpioPort> = Vec::new();
    for pin in pins {
        // Port letter = second char of "P{A-Z}{0-31}"; fall back to "?".
        let port_index = pin
            .pin_name
            .chars()
            .enumerate()
            .find(|(pos, c)| c.is_ascii_alphabetic() && !(*pos == 0 && c.eq_ignore_ascii_case(&'P')))
            .and_then(|(_, c)| c.to_ascii_uppercase().try_into().ok())
            .map(|b: u8| b.wrapping_sub(b'A'))
            .unwrap_or(u8::MAX);
        let port_name = pin
            .pin_name
            .chars()
            .take(2)
            .collect::<String>()
            .to_ascii_uppercase();
        match ports.last_mut() {
            Some(port) if port.port_name == port_name => port.pins.push(pin),
            _ => ports.push(RuntimeGpioPort {
                port_name,
                port_index,
                pins: vec![pin],
            }),
        }
    }
    ports
}

fn read_u32_le(buf: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]])
}

fn write_u32_le(buf: &mut [u8], offset: usize, val: u32) {
    let bytes = val.to_le_bytes();
    buf[offset..offset + 4].copy_from_slice(&bytes);
}

#[tauri::command]
pub fn read_pio_port(
    state: State<'_, AppState>,
    base_addr: u32,
    port_index: u8,
    port_name: String,
) -> Result<Vec<PioPinState>, String> {
    let _busy = state.try_acquire_busy("read_pio_port")?;
    let port_addr = base_addr.saturating_add((port_index as u32) * 0x24);
    let regs = efel_read_sync(port_addr, 36)?;
    if regs.len() < 36 {
        return Err("PIO 寄存器读取长度不足 36 字节".into());
    }

    let dat = read_u32_le(&regs, 0x10);
    let mut pins = Vec::with_capacity(32);

    for idx in 0..32u8 {
        let cfg_reg = read_u32_le(&regs, ((idx / 8) as usize) * 4);
        let cfg_shift = (idx % 8) * 4;
        let mux = ((cfg_reg >> cfg_shift) & 0x0f) as u8;

        let drv_reg = read_u32_le(&regs, 0x14 + ((idx / 16) as usize) * 4);
        let drv_shift = (idx % 16) * 2;
        let drv = ((drv_reg >> drv_shift) & 0x03) as u8;

        let pul_reg = read_u32_le(&regs, 0x1c + ((idx / 16) as usize) * 4);
        let pul_shift = (idx % 16) * 2;
        let pull = ((pul_reg >> pul_shift) & 0x03) as u8;

        let data = ((dat >> idx) & 0x01) as u8;

        pins.push(PioPinState {
            index: idx,
            name: format!("{}{}", port_name, idx),
            mux,
            data,
            drv,
            pull,
        });
    }

    Ok(pins)
}

#[tauri::command]
pub fn write_pio_pin(
    state: State<'_, AppState>,
    base_addr: u32,
    port_index: u8,
    pin_index: u8,
    mux: u8,
    pull: u8,
    drv: u8,
) -> Result<(), String> {
    if pin_index >= 32 {
        return Err("引脚编号超出范围 (0~31)".into());
    }
    let _busy = state.try_acquire_busy("write_pio_pin")?;
    let port_addr = base_addr.saturating_add((port_index as u32) * 0x24);
    let mut regs = efel_read_sync(port_addr, 36)?;

    let cfg_off = ((pin_index / 8) as usize) * 4;
    let cfg_shift = (pin_index % 8) * 4;
    let mut cfg_val = read_u32_le(&regs, cfg_off);
    cfg_val = (cfg_val & !(0x0f << cfg_shift)) | (((mux & 0x0f) as u32) << cfg_shift);
    write_u32_le(&mut regs, cfg_off, cfg_val);

    let drv_off = 0x14 + ((pin_index / 16) as usize) * 4;
    let drv_shift = (pin_index % 16) * 2;
    let mut drv_val = read_u32_le(&regs, drv_off);
    drv_val = (drv_val & !(0x03 << drv_shift)) | (((drv & 0x03) as u32) << drv_shift);
    write_u32_le(&mut regs, drv_off, drv_val);

    let pul_off = 0x1c + ((pin_index / 16) as usize) * 4;
    let pul_shift = (pin_index % 16) * 2;
    let mut pul_val = read_u32_le(&regs, pul_off);
    pul_val = (pul_val & !(0x03 << pul_shift)) | (((pull & 0x03) as u32) << pul_shift);
    write_u32_le(&mut regs, pul_off, pul_val);

    efel_write_sync(port_addr, regs)
}

#[tauri::command]
pub fn adb_detect_gpio(serial: String) -> Result<RuntimeGpioReport, String> {
    let compat = adb_exec_shell(
        serial.clone(),
        "cat /proc/device-tree/model 2>/dev/null || cat /sys/class/sunxi_info/sys_info 2>/dev/null | head -n 1".into(),
    )?;
    let chip = compat.trim().trim_end_matches('\0').to_string();
    let chip_label = if chip.is_empty() { "Allwinner Sunxi".into() } else { chip };

    let pinmux_raw = adb_exec_shell(
        serial.clone(),
        "cat /sys/kernel/debug/pinctrl/*/pinmux-pins 2>/dev/null".into(),
    )?;
    if pinmux_raw.trim().is_empty() {
        return Err("无法读取 /sys/kernel/debug/pinctrl/*/pinmux-pins，请先点击 Root 并确认内核已挂载 debugfs".into());
    }

    let pinconf_raw = adb_exec_shell(
        serial,
        "cat /sys/kernel/debug/pinctrl/*/pinconf-pins 2>/dev/null".into(),
    )
    .unwrap_or_default();

    let conf_map = parse_pinconf_map(&pinconf_raw);

    let pins = parse_pinmux_report(&pinmux_raw, &conf_map);

    if pins.is_empty() {
        return Err("未能从 pinmux-pins 解析到任何引脚数据".into());
    }

    let ports = group_pins_by_port(pins.clone());

    Ok(RuntimeGpioReport {
        chip: chip_label,
        ports,
        pins,
    })
}

#[tauri::command]
pub fn adb_set_gpio(
    serial: String,
    pin_name: String,
    mux: u8,
    pull: String,
    drv: String,
) -> Result<String, String> {
    let pull_val = match pull.as_str() {
        "Pull Up" => 1,
        "Pull Down" => 2,
        _ => 0,
    };
    let drv_val = u8::from_str_radix(drv.trim_start_matches("0x"), 16).unwrap_or(1);
    let cmd = format!(
        "if [ -w /sys/kernel/debug/sunxi_pinctrl/sunxi_pin_configure ]; then \
         echo '{0} {1}' > /sys/kernel/debug/sunxi_pinctrl/function && \
         echo '{0} {2}' > /sys/kernel/debug/sunxi_pinctrl/pull && \
         echo '{0} {3}' > /sys/kernel/debug/sunxi_pinctrl/dlevel; \
         else echo 'UNSUPPORTED'; fi",
        pin_name, mux, pull_val, drv_val
    );
    let res = adb_exec_shell(serial, cmd)?;
    if res.trim() == "UNSUPPORTED" {
        return Err("当前内核未暴露 /sys/kernel/debug/sunxi_pinctrl 写接口，仅支持只读查看".into());
    }
    Ok(res)
}

#[tauri::command]
pub fn adb_detect_gpio_port(serial: String, port_index: u8) -> Result<RuntimeGpioPort, String> {
    if port_index >= 32 {
        return Err("GPIO 端口索引超出范围 (0~31)".into());
    }
    let port_char = (b'A' + port_index) as char;
    let prefix = format!("P{}", port_char);

    let pinmux_raw = adb_exec_shell(
        serial.clone(),
        "cat /sys/kernel/debug/pinctrl/*/pinmux-pins 2>/dev/null".into(),
    )?;
    if pinmux_raw.trim().is_empty() {
        return Err(
            "无法读取 /sys/kernel/debug/pinctrl/*/pinmux-pins，请先点击 Root 并确认内核已挂载 debugfs".into(),
        );
    }

    let pinconf_raw = adb_exec_shell(
        serial.clone(),
        "cat /sys/kernel/debug/pinctrl/*/pinconf-pins 2>/dev/null".into(),
    )
    .unwrap_or_default();

    let conf_map = parse_pinconf_map(&pinconf_raw);
    let all_pins = parse_pinmux_report(&pinmux_raw, &conf_map);
    if all_pins.is_empty() {
        return Err("未能从 pinmux-pins 解析到任何引脚数据".into());
    }

    let pins: Vec<RuntimeGpioPin> = all_pins
        .into_iter()
        .filter(|p| p.pin_name.starts_with(&prefix))
        .collect();
    if pins.is_empty() {
        return Err(format!(
            "pinmux-pins 中未找到 {} 开头的引脚（芯片端口命名可能不同）",
            prefix
        ));
    }

    Ok(RuntimeGpioPort {
        port_name: prefix,
        port_index,
        pins,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PINMUX_SAMPLE: &str = "pin 0 (PB0) MUX UNCLAIMED GPIO UNCLAIMED\n\
        pin 1 (PB1) GPIO  sunxi-pinctrl pin 1 (PB1) function gpio_in func 1\n\
        pin 32 (PC0) 40000000 sunxi-pinctrl 32 40000000 function uart3 func 3\n\
        invalid line\n\
        pin 64 (PA0) GPIO  sunxi-pinctrl pin 64";

    #[test]
    fn parse_pinmux_groups_pins_and_fields() {
        let conf = parse_pinconf_map("");
        let pins = parse_pinmux_report(PINMUX_SAMPLE, &conf);
        assert_eq!(pins.len(), 4);
        assert_eq!(pins[0].pin_name, "PB0");
        assert_eq!(pins[0].gpio_id, 0);
        assert_eq!(pins[0].function, "IO_DISABLED");
        assert_eq!(pins[0].mux, 15);
        assert_eq!(pins[3].pin_name, "PA0");
        assert_eq!(pins[3].function, "GPIO");
        assert_eq!(pins[3].mux, 1);
    }

    #[test]
    fn parse_pinconf_map_extracts_entries() {
        let raw = "pin 32 (PC0) bias-disable drive-strength 20 mA default\n\
                   pin 64 (PA0) bias-pull-up drive-strength 10 mA\n";
        let map = parse_pinconf_map(raw);
        assert_eq!(map.get("PC0").unwrap(), "bias-disable drive-strength 20 mA default");
        assert_eq!(map.get("PA0").unwrap(), "bias-pull-up drive-strength 10 mA");
    }

    #[test]
    fn group_ports_follows_pin_order() {
        let conf = parse_pinconf_map("");
        let pins = parse_pinmux_report(PINMUX_SAMPLE, &conf);
        let ports = group_pins_by_port(pins);
        assert_eq!(ports.len(), 3);
        assert_eq!(ports[0].port_name, "PB");
        assert_eq!(ports[0].port_index, 1);
        assert_eq!(ports[0].pins.len(), 2);
        assert_eq!(ports[1].port_name, "PC");
        assert_eq!(ports[2].port_name, "PA");
    }

    #[test]
    fn group_ports_fallback_for_unknown_prefix() {
        let pins = vec![RuntimeGpioPin {
            pin_name: "X9".into(),
            gpio_id: 9,
            function: "GPIO".into(),
            mux: 1,
            pull: "PULL DISABLE".into(),
            drv: "-".into(),
            data: "GPIO".into(),
            functions: vec![],
        }];
        let ports = group_pins_by_port(pins);
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].port_name, "X9");
        assert_eq!(ports[0].port_index, 23); // 'X' - 'A'

    }
}
