use std::collections::BTreeSet;

use serde::Serialize;

const TYPESCRIPT_CONTRACTS: &str = include_str!("../../src/services/desktop/contracts.ts");

pub fn rust_fields(value: &impl Serialize) -> BTreeSet<String> {
    serde_json::to_value(value)
        .expect("Rust contract fixture should serialize")
        .as_object()
        .expect("Rust contract fixture should be an object")
        .keys()
        .cloned()
        .collect()
}

pub fn typescript_interface_fields(interface_name: &str) -> BTreeSet<String> {
    let marker = format!("export interface {interface_name} {{");
    let body = TYPESCRIPT_CONTRACTS
        .split_once(&marker)
        .unwrap_or_else(|| panic!("missing TypeScript interface {interface_name}"))
        .1
        .split_once('}')
        .expect("TypeScript interface should have a closing brace")
        .0;

    body.lines()
        .filter_map(|line| line.trim().split_once(':').map(|(name, _)| name))
        .map(|name| name.trim_end_matches('?').to_owned())
        .collect()
}

pub fn typescript_string_constant_values(constant_name: &str) -> Vec<String> {
    let marker = format!("export const {constant_name} = [");
    let body = TYPESCRIPT_CONTRACTS
        .split_once(&marker)
        .unwrap_or_else(|| panic!("missing TypeScript constant {constant_name}"))
        .1
        .split_once("] as const;")
        .expect("TypeScript constant should end with ] as const;")
        .0;

    body.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.trim_end_matches(',').trim_matches('"').to_owned())
        .collect()
}

pub fn assert_interface_matches(interface_name: &str, value: &impl Serialize) {
    assert_eq!(
        rust_fields(value),
        typescript_interface_fields(interface_name),
        "Rust serialization and TypeScript {interface_name} fields drifted"
    );
}
