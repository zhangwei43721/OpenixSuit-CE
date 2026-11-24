use openixcli::config::mbr_parser::{SunxiMbr, MBR_SIZE};
use serde::Serialize;
use std::io::Cursor;

pub(super) const SECTOR_SIZE: u64 = 512;
pub(super) const CHUNK_SIZE: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct Partition {
    pub id: usize,
    pub name: String,
    pub start_sector: u64,
    pub sectors: u64,
}

pub(super) struct Layout {
    pub format: &'static str,
    pub partitions: Vec<Partition>,
}

fn read_sunxi_mbr(bytes: &[u8]) -> Option<SunxiMbr> {
    let bytes = bytes.get(..MBR_SIZE)?;
    let mbr = SunxiMbr::parse(bytes).ok()?;
    (crc32fast::hash(&bytes[4..]) == mbr.crc32).then_some(mbr)
}

fn validate_ranges(partitions: &[Partition], capacity: u64) -> Result<(), String> {
    let mut ranges = partitions
        .iter()
        .filter(|part| part.sectors != 0)
        .collect::<Vec<_>>();
    ranges.sort_unstable_by_key(|part| part.start_sector);
    let mut previous_end = 0;
    for part in ranges {
        let end = part.start_sector.checked_add(part.sectors);
        if part.start_sector < previous_end
            || part.start_sector == 0
            || end.is_none_or(|end| end > capacity)
        {
            return Err(format!(
                "分区 {} 的地址或长度超出范围，或与其他分区重叠",
                part.name
            ));
        }
        previous_end = end.unwrap();
    }
    Ok(())
}

fn gpt_from_prefix(bytes: &[u8]) -> Result<gptman::GPT, String> {
    let mut cursor = Cursor::new(bytes);
    cursor.set_position(SECTOR_SIZE);
    let header = gptman::GPTHeader::read_from(&mut cursor).map_err(|error| error.to_string())?;
    let entries_bytes = u64::from(header.number_of_partition_entries) * 128;
    if header.primary_lba != 1
        || header.size_of_partition_entry != 128
        || header.partition_entry_lba < 2
        || entries_bytes == 0
        || header
            .partition_entry_lba
            .checked_mul(SECTOR_SIZE)
            .and_then(|start| start.checked_add(entries_bytes))
            .is_none_or(|end| end > bytes.len() as u64)
    {
        return Err("GPT 分区表超出可读取的范围或格式不受支持".into());
    }
    gptman::GPT::read_from(&mut cursor, SECTOR_SIZE).map_err(|error| error.to_string())
}

pub(super) fn read_layout(
    mut read: impl FnMut(u32, &mut [u8]) -> Result<(), String>,
    reported_sectors: u64,
    storage_type: u32,
) -> Result<Layout, String> {
    if reported_sectors < CHUNK_SIZE as u64 / SECTOR_SIZE {
        return Err("设备报告的存储容量不足以读取分区表".into());
    }

    // 某些 FES 在一次读取逻辑扇区 0 的 64 KiB 时会重新推算分区地址。
    // 分两次读取以保留原始 GPT 地址和分区间空隙。
    let mut bytes = vec![0_u8; CHUNK_SIZE];
    let (first, second) = bytes.split_at_mut(CHUNK_SIZE / 2);
    read(0, first)?;
    read((first.len() as u64 / SECTOR_SIZE) as u32, second)?;

    if bytes.get(512..520) == Some(b"EFI PART") {
        let gpt = gpt_from_prefix(&bytes)?;
        let mut offset = 0;
        if matches!(storage_type, 1 | 2 | 6 | 7) {
            // MMC 的 GPT 地址可以包含物理保留区，而 FES 读回使用逻辑扇区。
            // 仅使用 FES 转换表中首个已确认的条目推导偏移，其余地址取原始 GPT。
            let first = gpt.iter().next().ok_or("GPT 为空")?.1;
            if first.is_unused()
                || first.starting_lba == 0
                || gpt.header.partition_entry_lba != 2
                || gpt.iter().filter(|(_, part)| part.is_used()).count() >= 119
                || gpt
                    .iter()
                    .map(|(_, part)| part)
                    .zip(gpt.iter().skip(1).map(|(_, part)| part))
                    .any(|(left, right)| left.is_unused() && right.is_used())
            {
                return Err("当前 MMC GPT 无法可靠换算为 FES 逻辑地址".into());
            }
            let mut probe = vec![0_u8; CHUNK_SIZE];
            read(0, &mut probe)?;
            let translated = read_sunxi_mbr(&probe)
                .and_then(|mbr| mbr.partitions.into_iter().next())
                .ok_or("此板的 FES 未提供可验证的 MMC 逻辑地址")?;
            let length = first
                .ending_lba
                .checked_sub(first.starting_lba)
                .and_then(|value| value.checked_add(1));
            if first.partition_name.as_str() != translated.name
                || length != Some(translated.length())
                || translated.address() == 0
            {
                return Err("MMC 的 GPT 与 FES 地址换算结果不一致".into());
            }
            offset = first
                .starting_lba
                .checked_sub(translated.address())
                .ok_or("MMC GPT 原始地址小于 FES 逻辑地址")?;
        }

        let capacity = reported_sectors
            .checked_sub(offset)
            .ok_or("分区表的逻辑偏移超出设备容量")?;
        let mut partitions = Vec::new();
        for (id, part) in gpt.iter().filter(|(_, part)| part.is_used()) {
            if part.starting_lba < gpt.header.first_usable_lba
                || part.ending_lba > gpt.header.last_usable_lba
            {
                return Err(format!("GPT 分区 {id} 超出可用扇区范围"));
            }
            let start_sector = part
                .starting_lba
                .checked_sub(offset)
                .ok_or("分区地址小于逻辑偏移")?;
            let sectors = part
                .ending_lba
                .checked_sub(part.starting_lba)
                .and_then(|value| value.checked_add(1))
                .ok_or("GPT 分区结束地址无效")?;
            let name = part.partition_name.to_string();
            partitions.push(Partition {
                id: id as usize,
                name: if name.is_empty() {
                    format!("partition-{id}")
                } else {
                    name
                },
                start_sector,
                sectors,
            });
        }
        validate_ranges(&partitions, capacity)?;
        if partitions.is_empty() {
            return Err("GPT 没有可导出的分区".into());
        }
        return Ok(Layout {
            format: "gpt",
            partitions,
        });
    }

    let mut copies = bytes
        .chunks_exact(MBR_SIZE)
        .filter_map(read_sunxi_mbr)
        .map(|mbr| {
            mbr.partitions
                .iter()
                .enumerate()
                .filter(|(_, part)| !part.name.is_empty())
                .map(|(i, part)| Partition {
                    id: i + 1,
                    name: part.name.clone(),
                    start_sector: part.address(),
                    sectors: part.length(),
                })
                .collect::<Vec<_>>()
        });
    let partitions = copies
        .next()
        .filter(|parts| !parts.is_empty())
        .ok_or("读不到有效的 GPT 或全志 MBR 分区表")?;
    if copies.any(|copy| copy != partitions) {
        return Err("设备上的全志 MBR 副本不一致，无法确定分区地址".into());
    }
    validate_ranges(&partitions, reported_sectors)?;
    Ok(Layout {
        format: "sunxi-mbr",
        partitions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use openixcli::config::mbr_parser::{SunxiMbrRaw, SunxiPartitionRaw};
    use std::mem::offset_of;

    fn legacy_mbr(name: &str, start: u32, sectors: u32) -> Vec<u8> {
        let mut bytes = vec![0; MBR_SIZE];
        bytes[8..16].copy_from_slice(b"softw411");
        bytes[24..28].copy_from_slice(&1_u32.to_le_bytes());
        let part = &mut bytes[offset_of!(SunxiMbrRaw, partitions)..];
        let start_offset = offset_of!(SunxiPartitionRaw, addrlo);
        part[start_offset..start_offset + 4].copy_from_slice(&start.to_le_bytes());
        let size_offset = offset_of!(SunxiPartitionRaw, lenlo);
        part[size_offset..size_offset + 4].copy_from_slice(&sectors.to_le_bytes());
        let name_offset = offset_of!(SunxiPartitionRaw, name);
        part[name_offset..name_offset + name.len()].copy_from_slice(name.as_bytes());
        let crc = crc32fast::hash(&bytes[4..]);
        bytes[..4].copy_from_slice(&crc.to_le_bytes());
        bytes
    }

    fn read_bytes(disk: &[u8], sector: u32, out: &mut [u8]) -> Result<(), String> {
        let start = sector as usize * SECTOR_SIZE as usize;
        out.copy_from_slice(disk.get(start..start + out.len()).ok_or("short read")?);
        Ok(())
    }

    #[test]
    fn uses_raw_gpt_ranges_and_derives_only_the_mmc_offset() {
        let mut disk = Cursor::new(vec![0; 1024 * 512]);
        let mut gpt = gptman::GPT::new_from(&mut disk, 512, [1; 16]).unwrap();
        for (id, name, start, end) in [(1, "boot", 256, 383), (2, "rootfsB", 512, 640)] {
            gpt[id] = gptman::GPTPartitionEntry {
                partition_type_guid: [2; 16],
                unique_partition_guid: [id as u8 + 2; 16],
                starting_lba: start,
                ending_lba: end,
                attribute_bits: 0,
                partition_name: name.into(),
            };
        }
        gpt.write_into(&mut disk).unwrap();
        let disk = disk.into_inner();
        let normalized = legacy_mbr("boot", 128, 128);
        let layout = read_layout(
            |sector, out| {
                if sector == 0 && out.len() == CHUNK_SIZE {
                    out[..normalized.len()].copy_from_slice(&normalized);
                    return Ok(());
                }
                read_bytes(&disk, sector, out)
            },
            1024,
            2,
        )
        .unwrap();
        assert_eq!(layout.format, "gpt");
        assert_eq!(layout.partitions[0].start_sector, 128);
        assert_eq!(layout.partitions[1].start_sector, 384);
        assert_eq!(layout.partitions[1].sectors, 129);
        assert!(read_layout(|sector, out| read_bytes(&disk, sector, out), 1024, 2).is_err());
    }

    #[test]
    fn validates_sunxi_mbr_checksum_and_bounds() {
        let mut disk = vec![0; CHUNK_SIZE];
        disk[..MBR_SIZE].copy_from_slice(&legacy_mbr("rootfsB", 256, 32));
        let layout = read_layout(|sector, out| read_bytes(&disk, sector, out), 512, 5).unwrap();
        assert_eq!(layout.partitions[0].name, "rootfsB");
        assert!(read_layout(|sector, out| read_bytes(&disk, sector, out), 270, 5).is_err());
        disk[1024] ^= 1;
        assert!(read_layout(|sector, out| read_bytes(&disk, sector, out), 512, 5).is_err());
    }
}
