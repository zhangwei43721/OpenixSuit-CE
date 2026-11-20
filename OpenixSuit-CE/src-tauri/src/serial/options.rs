use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SerialOptions {
    pub receive_format: SerialFormat,
    pub send_format: SerialFormat,
    pub charset: SerialCharset,
    pub line_ending: SerialLineEnding,
    pub auto_scroll: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SerialFormat {
    Text,
    Hex,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SerialCharset {
    #[serde(rename = "utf-8")]
    Utf8,
    Gb18030,
    Big5,
    Latin1,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SerialLineEnding {
    Lf,
    CrLf,
    Cr,
    None,
}

impl SerialLineEnding {
    pub(super) fn parse(input: Option<&str>) -> Result<Self, String> {
        match input.map(str::to_ascii_lowercase).as_deref() {
            Some("lf") => Ok(Self::Lf),
            Some("crlf") => Ok(Self::CrLf),
            Some("cr") => Ok(Self::Cr),
            Some("none") | None => Ok(Self::None),
            Some(other) => Err(format!("Invalid append_newline mode: {other}")),
        }
    }

    pub(super) fn bytes(&self) -> &'static [u8] {
        match self {
            Self::Lf => b"\n",
            Self::CrLf => b"\r\n",
            Self::Cr => b"\r",
            Self::None => b"",
        }
    }
}

pub(super) fn decode_hex(input: &str) -> Result<Vec<u8>, String> {
    let incomplete = || "Hex data must contain complete bytes".to_string();
    let nibble = |value| (value as char).to_digit(16).map(|digit| digit as u8);
    let mut payload = Vec::new();
    for group in input.split_whitespace() {
        if group.len() % 2 != 0 {
            return Err(incomplete());
        }
        for pair in group.as_bytes().chunks_exact(2) {
            let byte = nibble(pair[0])
                .zip(nibble(pair[1]))
                .map(|(high, low)| (high << 4) | low)
                .ok_or_else(|| {
                    "Hex data can contain only hexadecimal digits and spaces".to_string()
                })?;
            payload.push(byte);
        }
    }
    if payload.is_empty() {
        return Err(incomplete());
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_complete_hex_bytes_with_whitespace() {
        assert_eq!(decode_hex("00 FF\n8da2").unwrap(), [0, 255, 141, 162]);
        assert!(decode_hex("F").is_err());
        assert!(decode_hex("0 0 FF").is_err());
        assert!(decode_hex("０0").is_err());
        assert!(decode_hex(" 	").is_err());
    }
}
