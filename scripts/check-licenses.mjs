import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const virtualStore = join(projectRoot, "node_modules", ".pnpm");
export const LICENSE_FILE_REVIEW = "SEE LICENSE FILE";

const REVIEWED_NODE_LICENSES = new Map([
  [
    "css-value@0.0.1",
    {
      license: "MIT",
      evidenceFile: "Readme.md",
      evidenceText: "(The MIT License)",
    },
  ],
]);

export function readPackage(packageDirectory) {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(packageDirectory, "package.json"), "utf8"),
    );
    const license =
      typeof packageJson.license === "string"
        ? packageJson.license
        : packageJson.licenses
            ?.map((entry) => (typeof entry === "string" ? entry : entry.type))
            .filter(Boolean)
            .join(" OR ");

    const packageIdentity = `${packageJson.name}@${packageJson.version}`;
    const reviewedLicense = REVIEWED_NODE_LICENSES.get(packageIdentity);
    let reviewedEvidence = null;
    if (reviewedLicense) {
      try {
        reviewedEvidence = readFileSync(
          join(packageDirectory, reviewedLicense.evidenceFile),
          "utf8",
        );
      } catch {
        // Keep the package in the inventory with a missing license so policy fails closed.
      }
    }
    const resolvedReviewedLicense = reviewedEvidence?.includes(reviewedLicense.evidenceText)
      ? reviewedLicense.license
      : null;

    return {
      name: packageJson.name,
      version: packageJson.version,
      license: license || resolvedReviewedLicense,
      ...(resolvedReviewedLicense
        ? { licenseSource: `reviewed:${reviewedLicense.evidenceFile}` }
        : {}),
    };
  } catch {
    return null;
  }
}

function collectNodePackages() {
  const packages = new Map();
  const lockedPackages = new Set();
  const lockfileLines = readFileSync(
    join(projectRoot, "pnpm-lock.yaml"),
    "utf8",
  ).split("\n");
  let inPackagesSection = false;

  for (const line of lockfileLines) {
    if (line === "packages:") {
      inPackagesSection = true;
      continue;
    }
    if (line === "snapshots:") break;
    if (!inPackagesSection) continue;

    const match = line.match(/^  (?:'([^']+)'|([^:]+)):\s*$/);
    const packageIdentity = match?.[1] || match?.[2];
    if (packageIdentity) lockedPackages.add(packageIdentity);
  }

  for (const storeEntry of readdirSync(virtualStore, { withFileTypes: true })) {
    if (!storeEntry.isDirectory()) continue;

    const modulesDirectory = join(virtualStore, storeEntry.name, "node_modules");
    let moduleEntries;
    try {
      moduleEntries = readdirSync(modulesDirectory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const moduleEntry of moduleEntries) {
      if (!moduleEntry.isDirectory()) continue;

      if (moduleEntry.name.startsWith("@")) {
        const scopeDirectory = join(modulesDirectory, moduleEntry.name);
        for (const scopedEntry of readdirSync(scopeDirectory, {
          withFileTypes: true,
        })) {
          if (!scopedEntry.isDirectory()) continue;
          const packageInfo = readPackage(join(scopeDirectory, scopedEntry.name));
          if (packageInfo) {
            packages.set(`${packageInfo.name}@${packageInfo.version}`, packageInfo);
          }
        }
      } else {
        const packageInfo = readPackage(join(modulesDirectory, moduleEntry.name));
        if (packageInfo) {
          packages.set(`${packageInfo.name}@${packageInfo.version}`, packageInfo);
        }
      }
    }
  }

  return [...packages.values()]
    .filter((packageInfo) =>
      lockedPackages.has(`${packageInfo.name}@${packageInfo.version}`),
    )
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(
        `${right.name}@${right.version}`,
      ),
    );
}

export const RUST_LICENSE_FEATURE_SETS = [[], ["e2e"]];

export function rustMetadataArguments(features = []) {
  return [
    "metadata",
    "--locked",
    "--format-version",
    "1",
    "--manifest-path",
    join(projectRoot, "src-tauri", "Cargo.toml"),
    ...(features.length > 0 ? ["--features", features.join(",")] : []),
  ];
}

function collectRustPackages() {
  const packages = new Map();

  // The optional E2E driver never ships in production, but it is still executable development
  // tooling. Scan the union of the production and E2E dependency graphs so license failures
  // cannot hide behind a disabled-by-default Cargo feature.
  for (const features of RUST_LICENSE_FEATURE_SETS) {
    const metadata = JSON.parse(
      execFileSync("cargo", rustMetadataArguments(features), {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
    const workspacePackages = new Set(metadata.workspace_members);
    for (const packageInfo of metadata.packages) {
      if (!workspacePackages.has(packageInfo.id)) packages.set(packageInfo.id, packageInfo);
    }
  }

  return [...packages.values()]
    .map((packageInfo) => ({
      name: packageInfo.name,
      version: packageInfo.version,
      license: packageInfo.license ||
        (packageInfo.license_file ? LICENSE_FILE_REVIEW : null),
    }))
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(
        `${right.name}@${right.version}`,
      ),
    );
}

function summarize(packages) {
  const licenses = {};
  for (const packageInfo of packages) {
    const license = packageInfo.license || "MISSING";
    licenses[license] = (licenses[license] || 0) + 1;
  }
  return licenses;
}

export function findLicenseProblems(packages) {
  const deniedLicense = /\b(?:AGPL|GPL|SSPL|BUSL)(?:\b|-)/i;
  return packages.filter(
    (packageInfo) =>
      !packageInfo.license ||
      packageInfo.license === LICENSE_FILE_REVIEW ||
      packageInfo.license
        .split(/\s+OR\s+/i)
        .every((choice) => deniedLicense.test(choice)),
  );
}

function buildReport(nodePackages, rustPackages, includeInventory) {
  const problems = findLicenseProblems([...nodePackages, ...rustPackages]);
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      nodePackages: nodePackages.length,
      rustPackages: rustPackages.length,
      problems: problems.length,
      nodeLicenses: summarize(nodePackages),
      rustLicenses: summarize(rustPackages),
    },
    problems,
    ...(includeInventory ? { nodePackages, rustPackages } : {}),
  };
}

function run() {
  const fixtureArgumentIndex = process.argv.indexOf("--policy-fixture");
  const report = fixtureArgumentIndex >= 0
    ? buildReport(
        JSON.parse(readFileSync(resolve(process.argv[fixtureArgumentIndex + 1]), "utf8")),
        [],
        true,
      )
    : buildReport(
        collectNodePackages(),
        collectRustPackages(),
        process.argv.includes("--json"),
      );

  console.log(JSON.stringify(report, null, 2));
  if (report.problems.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run();
}
