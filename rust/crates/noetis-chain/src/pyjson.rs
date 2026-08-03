//! Python-compatible JSON serialization.
//!
//! The Noetis wire protocol hashes and signs JSON produced by CPython's
//! `json.dumps(..., sort_keys=True)` (block hashes, merkle leaves) and
//! `json.dumps(..., sort_keys=True, separators=(",", ":"))` (signatures).
//! Every byte must match: keys sorted, non-ASCII escaped as `\uXXXX`, and
//! floats printed with Python's `repr` algorithm.

use serde_json::Value;
use std::collections::BTreeMap;

/// `json.dumps(value, sort_keys=True)` — item separator `", "`, key separator `": "`.
pub fn dumps_sorted(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, ", ", ": ");
    out
}

/// `json.dumps(value, sort_keys=True, separators=(",", ":"))` — compact form
/// used for transaction and validator signatures.
pub fn dumps_canonical(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, ",", ":");
    out
}

fn write_value(out: &mut String, value: &Value, item_sep: &str, key_sep: &str) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                out.push_str(&i.to_string());
            } else if let Some(u) = n.as_u64() {
                out.push_str(&u.to_string());
            } else {
                out.push_str(&python_float_repr(n.as_f64().unwrap_or(0.0)));
            }
        }
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep);
                }
                write_value(out, item, item_sep, key_sep);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let sorted: BTreeMap<&String, &Value> = map.iter().collect();
            out.push('{');
            for (i, (key, item)) in sorted.iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep);
                }
                write_string(out, key);
                out.push_str(key_sep);
                write_value(out, item, item_sep, key_sep);
            }
            out.push('}');
        }
    }
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c if (c as u32) < 0x7f => out.push(c),
            c => {
                // ensure_ascii=True: BMP chars as \uXXXX, astral as surrogate pairs.
                let cp = c as u32;
                if cp <= 0xFFFF {
                    out.push_str(&format!("\\u{:04x}", cp));
                } else {
                    let v = cp - 0x10000;
                    let high = 0xD800 + (v >> 10);
                    let low = 0xDC00 + (v & 0x3FF);
                    out.push_str(&format!("\\u{:04x}\\u{:04x}", high, low));
                }
            }
        }
    }
    out.push('"');
}

/// CPython `repr(float)`: shortest round-trip digits, scientific notation when
/// the decimal exponent is < -4 or >= 16, exponent always signed with >= 2 digits.
pub fn python_float_repr(f: f64) -> String {
    if f == 0.0 {
        return if f.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }

    // Rust's `{:e}` gives the shortest round-trip digits in scientific form.
    let sci = format!("{:e}", f.abs());
    let (mantissa, exp_str) = sci.split_once('e').expect("exponent");
    let exp: i32 = exp_str.parse().expect("exp parse");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let sign = if f < 0.0 { "-" } else { "" };

    if exp < -4 || exp >= 16 {
        // Scientific: 1e+16, 1.5e-05
        let mant = if digits.len() == 1 {
            digits.clone()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        let esign = if exp < 0 { '-' } else { '+' };
        format!("{}{}e{}{:02}", sign, mant, esign, exp.abs())
    } else if exp >= 0 {
        let point = (exp + 1) as usize;
        if digits.len() <= point {
            let padded = format!("{}{}", digits, "0".repeat(point - digits.len()));
            format!("{}{}.0", sign, padded)
        } else {
            format!("{}{}.{}", sign, &digits[..point], &digits[point..])
        }
    } else {
        let zeros = (-exp - 1) as usize;
        format!("{}0.{}{}", sign, "0".repeat(zeros), digits)
    }
}

/// Python `round(x, 6)` — correctly-rounded to 6 decimals, ties to even.
pub fn round6(x: f64) -> f64 {
    round_dp(x, 6)
}

/// Python `round(x, 4)`.
pub fn round4(x: f64) -> f64 {
    round_dp(x, 4)
}

/// Python `round(x, 1)`.
pub fn round1(x: f64) -> f64 {
    round_dp(x, 1)
}

fn round_dp(x: f64, dp: usize) -> f64 {
    // Rust's fixed-precision formatting is correctly rounded with ties-to-even,
    // matching CPython's round(float, ndigits).
    format!("{:.*}", dp, x).parse().unwrap_or(x)
}

pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

pub fn sha256_text(text: &str) -> String {
    sha256_hex(text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn float_repr_matches_python() {
        assert_eq!(python_float_repr(0.0), "0.0");
        assert_eq!(python_float_repr(1.0), "1.0");
        assert_eq!(python_float_repr(1000000.0), "1000000.0");
        assert_eq!(python_float_repr(1784134857.3623438), "1784134857.3623438");
        assert_eq!(python_float_repr(1e16), "1e+16");
        assert_eq!(python_float_repr(1.5e16), "1.5e+16");
        assert_eq!(python_float_repr(1e-6), "1e-06");
        assert_eq!(python_float_repr(0.0001), "0.0001");
        assert_eq!(python_float_repr(-0.5), "-0.5");
        assert_eq!(python_float_repr(120.0), "120.0");
        assert_eq!(python_float_repr(1e15), "1000000000000000.0");
    }

    #[test]
    fn json_floats_roundtrip_through_serde() {
        // Regression: serde_json's default float parse is off by 1 ULP for some
        // values (fixed by the float_roundtrip feature). Signatures depend on it.
        let value: Value = serde_json::from_str("1784139470.4454541").unwrap();
        assert_eq!(python_float_repr(value.as_f64().unwrap()), "1784139470.4454541");
    }

    #[test]
    fn dumps_escapes_non_ascii() {
        let v = json!({"data": "Genesis \u{2014} chain"});
        assert_eq!(dumps_sorted(&v), r#"{"data": "Genesis \u2014 chain"}"#);
        assert_eq!(dumps_canonical(&v), r#"{"data":"Genesis \u2014 chain"}"#);
    }

    #[test]
    fn dumps_sorts_keys() {
        let v = json!({"b": 1, "a": {"d": null, "c": true}});
        assert_eq!(dumps_canonical(&v), r#"{"a":{"c":true,"d":null},"b":1}"#);
    }
}
