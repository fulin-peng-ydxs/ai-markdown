use std::collections::BTreeSet;

use serde::Serialize;

const TYPESCRIPT_CONTRACTS: &str = include_str!("../../src/services/desktop/contracts.ts");
const RUST_CONTRACT_ASSERTION_SOURCES: &[&str] = &[
    include_str!("commands/workspace.rs"),
    include_str!("editor/assets.rs"),
    include_str!("editor/recovery.rs"),
    include_str!("editor/save_copy.rs"),
    include_str!("error.rs"),
    include_str!("fs/delete.rs"),
    include_str!("fs/model.rs"),
    include_str!("fs/mutate.rs"),
    include_str!("fs/read.rs"),
    include_str!("fs/safe_write.rs"),
    include_str!("fs/scan.rs"),
    include_str!("fs/watch.rs"),
    include_str!("menu.rs"),
    include_str!("preferences.rs"),
    include_str!("state.rs"),
    include_str!("window.rs"),
];

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

fn typescript_export_names(prefix: &str) -> BTreeSet<String> {
    TYPESCRIPT_CONTRACTS
        .lines()
        .filter_map(|line| line.strip_prefix(prefix))
        .filter_map(|remainder| {
            remainder
                .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
                .next()
        })
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect()
}

fn rust_contract_assertion_names(function_name: &str) -> BTreeSet<String> {
    RUST_CONTRACT_ASSERTION_SOURCES
        .iter()
        .flat_map(|source| {
            source
                .match_indices(function_name)
                .map(move |(index, _)| &source[index + function_name.len()..])
        })
        .filter_map(|tail| {
            let arguments = tail.trim_start().strip_prefix('(')?;
            let quoted = arguments.split_once('"')?.1;
            Some(quoted.split_once('"')?.0.to_owned())
        })
        .collect()
}

#[test]
fn every_exported_typescript_contract_has_a_rust_parity_assertion() {
    assert_eq!(
        typescript_export_names("export interface "),
        rust_contract_assertion_names("assert_interface_matches"),
        "every exported TypeScript interface must have a Rust serialized-field parity assertion"
    );
    assert_eq!(
        typescript_export_names("export const "),
        rust_contract_assertion_names("typescript_string_constant_values"),
        "every exported TypeScript string constant must have a Rust enum/tag parity assertion"
    );
}
