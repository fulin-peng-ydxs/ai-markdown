use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

const TYPESCRIPT_CONTRACTS: &str = include_str!("../../src/services/desktop/contracts.ts");
const RUST_CONTRACT_ASSERTION_SOURCES: &[&str] = &[
    include_str!("commands/workspace.rs"),
    include_str!("commands/window_session.rs"),
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
    include_str!("window_session.rs"),
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

fn typescript_tagged_variant_fields(type_name: &str) -> BTreeMap<String, BTreeSet<String>> {
    let marker = format!("export type {type_name} =");
    let body = TYPESCRIPT_CONTRACTS
        .split_once(&marker)
        .unwrap_or_else(|| panic!("missing TypeScript type alias {type_name}"))
        .1
        .split_once(";\n\n")
        .expect("TypeScript type alias should end with a semicolon");
    let mut variants = BTreeMap::new();
    let mut current_fields = None::<BTreeSet<String>>;
    let mut current_tag = None::<String>;

    for line in body.0.lines().map(str::trim) {
        if line == "| {" {
            assert!(
                current_fields.is_none(),
                "nested TypeScript tagged variant in {type_name}"
            );
            current_fields = Some(BTreeSet::new());
            current_tag = None;
            continue;
        }
        if line == "}" {
            let fields = current_fields
                .take()
                .unwrap_or_else(|| panic!("closing unopened TypeScript variant in {type_name}"));
            let tag = current_tag
                .take()
                .unwrap_or_else(|| panic!("TypeScript variant in {type_name} has no kind tag"));
            assert!(
                variants.insert(tag.clone(), fields).is_none(),
                "duplicate TypeScript {type_name} variant tag {tag}"
            );
            continue;
        }

        let Some(fields) = current_fields.as_mut() else {
            continue;
        };
        let Some((raw_name, raw_type)) = line.split_once(':') else {
            continue;
        };
        let field_name = raw_name.trim_end_matches('?').to_owned();
        fields.insert(field_name.clone());
        if field_name != "kind" {
            continue;
        }

        let tag_expression = raw_type.trim().trim_end_matches(';');
        current_tag = Some(if tag_expression.starts_with('"') {
            tag_expression.trim_matches('"').to_owned()
        } else {
            let indexed = tag_expression
                .strip_prefix("(typeof ")
                .and_then(|value| value.split_once(")["))
                .unwrap_or_else(|| {
                    panic!("unsupported TypeScript {type_name} kind expression {tag_expression}")
                });
            let index = indexed
                .1
                .trim_end_matches(']')
                .parse::<usize>()
                .expect("TypeScript tagged variant index should be numeric");
            typescript_string_constant_values(indexed.0)
                .get(index)
                .unwrap_or_else(|| {
                    panic!(
                        "TypeScript {type_name} kind index {index} is outside {}",
                        indexed.0
                    )
                })
                .clone()
        });
    }

    assert!(
        current_fields.is_none(),
        "unterminated TypeScript tagged variant in {type_name}"
    );
    assert!(
        !variants.is_empty(),
        "TypeScript type alias {type_name} has no tagged variants"
    );
    variants
}

pub fn assert_type_alias_matches_variants<T: Serialize>(type_name: &str, values: &[T]) {
    let mut rust_variants = BTreeMap::new();
    for value in values {
        let serialized =
            serde_json::to_value(value).expect("Rust tagged contract fixture should serialize");
        let object = serialized
            .as_object()
            .expect("Rust tagged contract fixture should be an object");
        let tag = object
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_else(|| panic!("Rust tagged variant in {type_name} has no string kind"));
        let fields = object.keys().cloned().collect::<BTreeSet<_>>();
        assert!(
            rust_variants.insert(tag.to_owned(), fields).is_none(),
            "duplicate Rust {type_name} variant tag {tag}"
        );
    }

    assert_eq!(
        rust_variants,
        typescript_tagged_variant_fields(type_name),
        "Rust tagged variants and TypeScript {type_name} per-variant fields drifted"
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

#[test]
#[should_panic(expected = "per-variant fields drifted")]
fn tagged_variant_parity_rejects_a_field_on_the_wrong_variant() {
    assert_type_alias_matches_variants(
        "WindowTabSelection",
        &[
            serde_json::json!({
                "kind": "visual",
                "anchor": 1,
                "head": 2
            }),
            serde_json::json!({
                "kind": "source",
                "from": 3,
                "to": 4
            }),
        ],
    );
}
