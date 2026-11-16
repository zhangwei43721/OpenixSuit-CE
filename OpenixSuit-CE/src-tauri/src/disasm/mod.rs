use capstone::prelude::*;
use serde::Serialize;

#[derive(Serialize)]
pub struct DisasmInsn {
    pub address: String,
    pub mnemonic: String,
    pub op_str: String,
}

#[tauri::command]
pub fn disassemble_bytes(
    arch: String,
    base_addr: u64,
    bytes: Vec<u8>,
) -> Result<Vec<DisasmInsn>, String> {
    let cs = match arch.as_str() {
        "arm32" => Capstone::new()
            .arm()
            .mode(arch::arm::ArchMode::Arm)
            .build()
            .map_err(|e| e.to_string())?,
        "aarch64" => Capstone::new()
            .arm64()
            .mode(arch::arm64::ArchMode::Arm)
            .build()
            .map_err(|e| e.to_string())?,
        "riscv32" => Capstone::new()
            .riscv()
            .mode(arch::riscv::ArchMode::RiscV32)
            .build()
            .map_err(|e| e.to_string())?,
        "riscv64" => Capstone::new()
            .riscv()
            .mode(arch::riscv::ArchMode::RiscV64)
            .build()
            .map_err(|e| e.to_string())?,
        "mips" => Capstone::new()
            .mips()
            .mode(arch::mips::ArchMode::Mips32)
            .build()
            .map_err(|e| e.to_string())?,
        "x86" => Capstone::new()
            .x86()
            .mode(arch::x86::ArchMode::Mode32)
            .build()
            .map_err(|e| e.to_string())?,
        "x86_64" => Capstone::new()
            .x86()
            .mode(arch::x86::ArchMode::Mode64)
            .build()
            .map_err(|e| e.to_string())?,
        _ => return Err(format!("不支持的架构: {}", arch)),
    };

    let insns = cs.disasm_all(&bytes, base_addr).map_err(|e| e.to_string())?;
    let result = insns
        .iter()
        .map(|i| DisasmInsn {
            address: format!("0x{:08x}", i.address()),
            mnemonic: i.mnemonic().unwrap_or("").to_string(),
            op_str: i.op_str().unwrap_or("").to_string(),
        })
        .collect();
    Ok(result)
}
