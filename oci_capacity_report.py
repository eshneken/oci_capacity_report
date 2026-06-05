#!/usr/bin/env python3

import argparse
import csv
import json
import os
import re
import subprocess
import sys
from collections import defaultdict


DEFAULT_FAMILIES = ("E5", "E6")
DEFAULT_FLEX_OCPUS = 1.0
DEFAULT_FLEX_MEMORY_GBS = 16.0


def parse_args():
    parser = argparse.ArgumentParser(
        description="Report OCI compute capacity for E5/E6 shapes across all subscribed regions."
    )
    parser.add_argument(
        "--profile",
        default=os.environ.get("OCI_CLI_PROFILE") or os.environ.get("OCI_PROFILE") or "DEFAULT",
        help="OCI config profile to use. Default: OCI_CLI_PROFILE, OCI_PROFILE, or DEFAULT.",
    )
    parser.add_argument(
        "--config-file",
        default=os.environ.get("OCI_CLI_CONFIG_FILE") or "~/.oci/config",
        help="OCI config file. Default: OCI_CLI_CONFIG_FILE or ~/.oci/config.",
    )
    parser.add_argument(
        "--families",
        default=",".join(DEFAULT_FAMILIES),
        help="Comma-separated shape families to match. Default: E5,E6.",
    )
    parser.add_argument(
        "--shapes",
        help="Comma-separated exact shape names. If set, skips shape discovery.",
    )
    parser.add_argument(
        "--regions",
        help="Comma-separated subscribed OCI region identifiers. If set, only these subscribed regions are checked.",
    )
    parser.add_argument(
        "--ocpus",
        type=float,
        help=f"OCPUs for Flex shape capacity checks. Use with --memory-gbs. Default: {DEFAULT_FLEX_OCPUS:g}.",
    )
    parser.add_argument(
        "--memory-gbs",
        type=float,
        help=f"Memory in GBs for Flex shape capacity checks. Use with --ocpus. Default: {DEFAULT_FLEX_MEMORY_GBS:g}.",
    )
    parser.add_argument(
        "--format",
        choices=("markdown", "table", "json", "csv"),
        default="markdown",
        help="Output format. Default: markdown.",
    )
    parser.add_argument(
        "--include-non-ready",
        action="store_true",
        help="Include region subscriptions whose status is not READY.",
    )
    parser.add_argument(
        "--list-regions",
        action="store_true",
        help="Print subscribed region identifiers as JSON and exit.",
    )
    args = parser.parse_args()

    if (args.ocpus is None) != (args.memory_gbs is None):
        parser.error("--ocpus and --memory-gbs must be provided together")
    if args.ocpus is not None and args.ocpus <= 0:
        parser.error("--ocpus must be positive")
    if args.memory_gbs is not None and args.memory_gbs <= 0:
        parser.error("--memory-gbs must be positive")

    args.config_file = os.path.expanduser(args.config_file)
    args.families = [item.strip() for item in args.families.split(",") if item.strip()]
    args.shapes = [item.strip() for item in args.shapes.split(",") if item.strip()] if args.shapes else None
    args.regions = [item.strip() for item in args.regions.split(",") if item.strip()] if args.regions else None
    return args


def parse_oci_config(config_file, profile):
    profiles = {}
    current = None

    with open(config_file, "r", encoding="utf-8") as config:
        for raw_line in config:
            line = raw_line.strip()
            if not line or line.startswith("#") or line.startswith(";"):
                continue

            section = re.match(r"^\[([^\]]+)\]$", line)
            if section:
                current = section.group(1).strip()
                profiles.setdefault(current, {})
                continue

            if current and "=" in line:
                key, value = line.split("=", 1)
                profiles[current][key.strip()] = value.strip()

    if profile not in profiles:
        raise RuntimeError(f"Profile {profile!r} was not found in {config_file}")
    if "tenancy" not in profiles[profile]:
        raise RuntimeError(f"Profile {profile!r} in {config_file} does not contain a tenancy value")

    return profiles[profile]


def oci(command_args, args):
    full_args = [
        "oci",
        *command_args,
        "--config-file",
        args.config_file,
        "--profile",
        args.profile,
        "--output",
        "json",
    ]
    result = subprocess.run(full_args, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        details = summarize_oci_error(result.stderr or result.stdout)
        raise RuntimeError(details or f"OCI CLI exited with status {result.returncode}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"OCI CLI returned non-JSON output: {exc}") from exc


def summarize_oci_error(output):
    text = re.sub(
        r"/opt/.*?FutureWarning:.*?\n\s*warnings\.warn\([^)]*\)\n?",
        "",
        output or "",
        flags=re.DOTALL,
    ).strip()
    marker = "RequestException:"
    if marker in text:
        request_error = text.split(marker, 1)[1].strip()
        try:
            payload = json.loads(request_error)
            return payload.get("message") or re.sub(r"\s+", " ", text)
        except json.JSONDecodeError:
            pass
    marker = "ServiceError:"
    if marker in text:
        service_error = text.split(marker, 1)[1].strip()
        try:
            payload = json.loads(service_error)
            bits = []
            if payload.get("status"):
                bits.append(str(payload["status"]))
            if payload.get("code"):
                bits.append(payload["code"])
            if payload.get("message"):
                bits.append(payload["message"])
            return " - ".join(bits)
        except json.JSONDecodeError:
            pass
    return re.sub(r"\s+", " ", text)


def data_list(response):
    data = response.get("data")
    return data if isinstance(data, list) else []


def get_value(item, *names, default=""):
    for name in names:
        if isinstance(item, dict) and item.get(name) is not None:
            return item[name]
    return default


def matches_default_shape_family(shape, families):
    parts = shape.split(".")
    if len(parts) != 4:
        return False
    shape_type, shape_class, family, size = parts
    return (
        shape_type in ("BM", "VM")
        and shape_class == "Standard"
        and family in families
        and (size == "Flex" or size.isdigit())
    )


def discover_regions(tenancy_id, args):
    response = oci(["iam", "region-subscription", "list", "--tenancy-id", tenancy_id, "--all"], args)
    regions = []
    for subscription in data_list(response):
        status = get_value(subscription, "status")
        region_name = get_value(subscription, "region-name", "regionName")
        if region_name and (args.include_non_ready or status == "READY"):
            regions.append(region_name)
    return sorted(set(regions))


def list_availability_domains(tenancy_id, region, args):
    response = oci(
        [
            "iam",
            "availability-domain",
            "list",
            "--compartment-id",
            tenancy_id,
            "--region",
            region,
            "--all",
        ],
        args,
    )
    return sorted(get_value(ad, "name") for ad in data_list(response) if get_value(ad, "name"))


def list_matching_shapes(tenancy_id, region, availability_domain, args):
    if args.shapes:
        return args.shapes

    response = oci(
        [
            "compute",
            "shape",
            "list",
            "--compartment-id",
            tenancy_id,
            "--availability-domain",
            availability_domain,
            "--region",
            region,
            "--all",
        ],
        args,
    )
    shapes = []
    for shape in data_list(response):
        name = get_value(shape, "shape", "name")
        if name and matches_default_shape_family(name, args.families):
            shapes.append(name)
    return sorted(set(shapes))


def shape_request(shape, args):
    request = {"instanceShape": shape}
    if shape.lower().endswith(".flex"):
        request["instanceShapeConfig"] = {
            "ocpus": args.ocpus if args.ocpus is not None else DEFAULT_FLEX_OCPUS,
            "memoryInGBs": args.memory_gbs if args.memory_gbs is not None else DEFAULT_FLEX_MEMORY_GBS,
        }
    return request


def capacity_report(tenancy_id, region, availability_domain, shapes, args):
    response = oci(
        [
            "compute",
            "compute-capacity-report",
            "create",
            "--availability-domain",
            availability_domain,
            "--compartment-id",
            tenancy_id,
            "--shape-availabilities",
            json.dumps([shape_request(shape, args) for shape in shapes]),
            "--region",
            region,
        ],
        args,
    )
    report = response.get("data", {})
    return report.get("shape-availabilities") or report.get("shapeAvailabilities") or []


def normalize_row(region, availability_domain, item):
    config = get_value(item, "instance-shape-config", "instanceShapeConfig", default={}) or {}
    return {
        "region": region,
        "availability_domain": availability_domain,
        "fault_domain": get_value(item, "fault-domain", "faultDomain", default="all"),
        "shape": get_value(item, "instance-shape", "instanceShape"),
        "status": get_value(item, "availability-status", "availabilityStatus"),
        "available_count": get_value(item, "available-count", "availableCount"),
        "ocpus": get_value(config, "ocpus"),
        "memory_gbs": get_value(config, "memory-in-gbs", "memoryInGBs"),
        "message": "",
    }


def note_row(region, availability_domain="", message=""):
    return {
        "region": region,
        "availability_domain": availability_domain,
        "fault_domain": "",
        "shape": "",
        "status": "INFO",
        "available_count": "",
        "ocpus": "",
        "memory_gbs": "",
        "message": message,
    }


def error_row(region, availability_domain="", shape="", error=""):
    return {
        "region": region,
        "availability_domain": availability_domain,
        "fault_domain": "",
        "shape": shape,
        "status": "ERROR",
        "available_count": "",
        "ocpus": "",
        "memory_gbs": "",
        "message": re.sub(r"\s+", " ", str(error)).strip(),
    }


def collect_rows(args):
    config = parse_oci_config(args.config_file, args.profile)
    tenancy_id = config["tenancy"]
    rows = []

    subscribed_regions = discover_regions(tenancy_id, args)
    if args.regions:
        requested_regions = set(args.regions)
        regions = [region for region in subscribed_regions if region in requested_regions]
        missing_regions = sorted(requested_regions.difference(subscribed_regions))
        for region in missing_regions:
            rows.append(error_row(region, error="Tenancy is not subscribed to this region"))
    else:
        regions = subscribed_regions

    for region in regions:
        print(f"Checking {region}...", file=sys.stderr, flush=True)
        try:
            availability_domains = list_availability_domains(tenancy_id, region, args)
        except RuntimeError as exc:
            rows.append(error_row(region, error=exc))
            continue

        if not availability_domains:
            rows.append(note_row(region, message="No availability domains found"))
            continue

        for availability_domain in availability_domains:
            try:
                shapes = list_matching_shapes(tenancy_id, region, availability_domain, args)
            except RuntimeError as exc:
                rows.append(error_row(region, availability_domain=availability_domain, error=exc))
                continue

            if not shapes:
                rows.append(
                    note_row(
                        region,
                        availability_domain,
                        f"No {'/'.join(args.families)} shapes found in this availability domain",
                    )
                )
                continue

            for shape in shapes:
                try:
                    report_items = capacity_report(tenancy_id, region, availability_domain, [shape], args)
                    rows.extend(normalize_row(region, availability_domain, item) for item in report_items)
                except RuntimeError as exc:
                    rows.append(error_row(region, availability_domain, shape, exc))

    return rows


def markdown_cell(value):
    return str(value if value is not None else "").replace("|", "\\|")


def render_markdown(rows):
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["region"]].append(row)

    lines = []
    for region in sorted(grouped):
        lines.append(f"## {region}")
        lines.append("")
        lines.append(
            "| Availability Domain | Fault Domain | Shape | Status | Available Count | OCPUs | Memory GBs | Message |"
        )
        lines.append("|---|---|---|---|---:|---:|---:|---|")
        for row in grouped[region]:
            lines.append(
                "| "
                + " | ".join(
                    markdown_cell(row[key])
                    for key in (
                        "availability_domain",
                        "fault_domain",
                        "shape",
                        "status",
                        "available_count",
                        "ocpus",
                        "memory_gbs",
                        "message",
                    )
                )
                + " |"
            )
        lines.append("")
    return "\n".join(lines)


def render_table(rows):
    headers = ["Region", "Availability Domain", "Fault Domain", "Shape", "Status", "Available", "OCPUs", "Memory", "Message"]
    keys = ["region", "availability_domain", "fault_domain", "shape", "status", "available_count", "ocpus", "memory_gbs", "message"]
    table = [[str(row[key] if row[key] is not None else "") for key in keys] for row in rows]
    widths = [max([len(headers[i]), *(len(row[i]) for row in table)]) for i in range(len(headers))]

    def line(values):
        return "  ".join(str(value).ljust(widths[i]) for i, value in enumerate(values))

    return "\n".join([line(headers), line("-" * width for width in widths), *(line(row) for row in table)])


def render_csv(rows):
    keys = ["region", "availability_domain", "fault_domain", "shape", "status", "available_count", "ocpus", "memory_gbs", "message"]
    output = sys.stdout
    writer = csv.DictWriter(output, fieldnames=keys)
    writer.writeheader()
    writer.writerows(rows)


def main():
    try:
        args = parse_args()
        if args.list_regions:
            config = parse_oci_config(args.config_file, args.profile)
            print(json.dumps(discover_regions(config["tenancy"], args), indent=2))
            return 0
        rows = collect_rows(args)
    except (OSError, RuntimeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if args.format == "json":
        print(json.dumps(rows, indent=2))
    elif args.format == "csv":
        render_csv(rows)
    elif args.format == "table":
        print(render_table(rows))
    else:
        print(render_markdown(rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
