"""
Remnant Biome - LOCA2-Hybrid CA Download Script
================================================
Downloads daily tasmax + tasmin from the Cal-Adapt S3 bucket for
3 models x 2 variables x 3 scenarios + historical.

Usage:
    python download_loca2.py --manifest       # print all 60 files with index numbers
    python download_loca2.py --test           # download file #1 only, then audit it
    python download_loca2.py --file 2         # download one specific file by index
    python download_loca2.py --audit          # audit already-downloaded files
    python download_loca2.py                  # full download (all 60 files)

Typical one-at-a-time workflow:
    python download_loca2.py --file 1
    python compute_metrics.py --model EC-Earth3 --scenario historical --delete-raw
    python download_loca2.py --file 2
    ... repeat

Requirements:
    pip install boto3 botocore xarray netcdf4

No AWS credentials needed - bucket is public (no-sign-request).
"""

import argparse
import boto3
import botocore
from pathlib import Path


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BUCKET   = "cadcat"
PREFIX   = "loca2/aaa-ca-hybrid"
BASE_DIR = Path("data/raw/loca2")

MODELS        = ["EC-Earth3", "MIROC6", "MRI-ESM2-0"]
SCENARIOS     = ["ssp245", "ssp370", "ssp585"]
VARIABLES     = ["tasmax", "tasmin"]
RIPF          = "r1i1p1f1"
RES           = "0p0625deg"
FUTURE_CHUNKS = ["2015-2044", "2045-2074", "2075-2100"]
HIST_CHUNK    = "1950-2014"
VERSION_TAG   = "v20230115"


# ---------------------------------------------------------------------------
# File path helpers
# ---------------------------------------------------------------------------

def build_s3_key(model, scenario, variable, chunk):
    filename = f"{variable}.{model}.{scenario}.{RIPF}.{chunk}.LOCA2_CA_hybrid_{VERSION_TAG}.nc"
    return f"{PREFIX}/{model}/{RES}/{RIPF}/{scenario}/{variable}/{filename}"


def build_local_path(model, scenario, variable, chunk):
    filename = f"{variable}.{model}.{scenario}.{RIPF}.{chunk}.nc"
    return BASE_DIR / model / scenario / variable / filename


def human_size(num_bytes):
    for unit in ["B", "KB", "MB", "GB"]:
        if num_bytes < 1024:
            return f"{num_bytes:.1f} {unit}"
        num_bytes /= 1024
    return f"{num_bytes:.1f} TB"


# ---------------------------------------------------------------------------
# Manifest builder
# ---------------------------------------------------------------------------

def build_manifest():
    """
    Returns list of (s3_key, local_path, label) tuples for all 60 files.
    Order: historical first (6 files), then future by model/scenario/variable/chunk.
    """
    manifest = []

    # Historical - 3 models x 2 variables = 6 files
    for model in MODELS:
        for variable in VARIABLES:
            key   = build_s3_key(model, "historical", variable, HIST_CHUNK)
            local = build_local_path(model, "historical", variable, HIST_CHUNK)
            label = f"{model} / historical / {variable}"
            manifest.append((key, local, label))

    # Future - 3 models x 3 scenarios x 2 variables x 3 chunks = 54 files
    for model in MODELS:
        for scenario in SCENARIOS:
            for variable in VARIABLES:
                for chunk in FUTURE_CHUNKS:
                    key   = build_s3_key(model, scenario, variable, chunk)
                    local = build_local_path(model, scenario, variable, chunk)
                    label = f"{model} / {scenario} / {variable} / {chunk}"
                    manifest.append((key, local, label))

    return manifest


# ---------------------------------------------------------------------------
# S3 client
# ---------------------------------------------------------------------------

def make_s3_client():
    return boto3.client(
        "s3",
        region_name="us-west-2",
        config=botocore.config.Config(signature_version=botocore.UNSIGNED)
    )


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def download_file(s3, key, local_path):
    """Download one file with progress. Skips if already exists."""
    if local_path.exists():
        print(f"  skipped (already exists): {local_path.name}")
        return True

    try:
        head = s3.head_object(Bucket=BUCKET, Key=key)
        size = head["ContentLength"]
    except Exception:
        print(f"  NOT FOUND on S3: {key}")
        return False

    local_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"  downloading {local_path.name} ({human_size(size)}) ...")

    downloaded = [0]

    def progress(chunk):
        downloaded[0] += chunk
        pct = downloaded[0] / size * 100
        print(
            f"\r    {pct:5.1f}%  {human_size(downloaded[0])} / {human_size(size)}",
            end="", flush=True,
        )

    s3.download_file(Bucket=BUCKET, Key=key, Filename=str(local_path), Callback=progress)
    print()
    return True


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------

def audit_file(local_path):
    try:
        import xarray as xr
    except ImportError:
        print("  xarray not installed. Run: pip install xarray netcdf4")
        return

    print()
    print("=" * 62)
    print(f"  AUDIT: {local_path.name}")
    print("=" * 62)

    ds = xr.open_dataset(local_path)

    print("\n  Dimensions:")
    for dim, size in ds.dims.items():
        print(f"    {dim}: {size}")

    lat_key = "lat" if "lat" in ds.coords else "latitude"
    lon_key = "lon" if "lon" in ds.coords else "longitude"
    lat = ds[lat_key].values
    lon = ds[lon_key].values

    lat_min, lat_max = float(lat.min()), float(lat.max())
    lon_min, lon_max = float(lon.min()), float(lon.max())

    # Normalize 0-360 longitudes for the check
    if lon_min > 180:
        lon_min = lon_min - 360
    if lon_max > 180:
        lon_max = lon_max - 360

    ca_lat_ok = lat_min <= 32.5 and lat_max >= 42.0
    ca_lon_ok = lon_min <= -124.5 and lon_max >= -114.1

    print(f"\n  Spatial bounds (normalized):")
    print(f"    Lat: {lat_min:.3f} to {lat_max:.3f} N   (CA needs 32.5 to 42.0)")
    print(f"    Lon: {lon_min:.3f} to {lon_max:.3f}     (CA needs -124.5 to -114.1)")
    print(f"    California fully covered: {'YES' if ca_lat_ok and ca_lon_ok else 'NO - investigate'}")

    time = ds["time"]
    t_start  = str(time.values[0])[:10]
    t_end    = str(time.values[-1])[:10]
    n_steps  = len(time)
    is_daily = n_steps > 300

    print(f"\n  Time axis:")
    print(f"    {t_start} to {t_end}  ({n_steps} steps)")
    print(f"    Looks daily: {'YES' if is_daily else 'NO - check this'}")

    print(f"\n  Data variables:")
    for v in ds.data_vars:
        units = ds[v].attrs.get("units", "not specified")
        print(f"    {v}: units = {units}")
        if units == "K":
            print(f"      Note: Kelvin - pipeline converts to Celsius on load")

    size_gb = local_path.stat().st_size / 1e9
    print(f"\n  File size on disk: {size_gb:.2f} GB")

    ds.close()
    print("=" * 62)
    print()


# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------

def run_manifest(manifest):
    """Print all files with index numbers."""
    print(f"\n  {'#':<5} {'LABEL':<45} {'STATUS'}")
    print(f"  {'-'*5} {'-'*45} {'-'*15}")
    for i, (key, local, label) in enumerate(manifest, 1):
        status = "downloaded" if local.exists() else "not yet"
        print(f"  {i:<5} {label:<45} {status}")
    print(f"\n  Total: {len(manifest)} files\n")


def run_file(manifest, index):
    """Download one specific file by 1-based index number."""
    if index < 1 or index > len(manifest):
        print(f"\n  Error: index {index} out of range (1-{len(manifest)})")
        print(f"  Run --manifest to see all files.\n")
        return

    key, local_path, label = manifest[index - 1]
    s3 = make_s3_client()

    print(f"\n  Downloading file {index}/{len(manifest)}: {label}")
    ok = download_file(s3, key, local_path)
    if ok or local_path.exists():
        audit_file(local_path)
        print(f"  Next step:")
        # Figure out model and scenario from local path for helpful hint
        parts = local_path.parts
        model    = parts[-4]
        scenario = parts[-3]
        print(f"    python compute_metrics.py --model {model} --scenario {scenario} --delete-raw")
        if index < len(manifest):
            print(f"    python download_loca2.py --file {index + 1}")
    else:
        print("  Download failed - check S3 key and connection.")


def run_test(manifest):
    """Download file #1 and audit it."""
    run_file(manifest, 1)


def run_audit(manifest):
    downloaded = [(k, p, l) for k, p, l in manifest if p.exists()]
    if not downloaded:
        print("\n  No downloaded files found yet.\n")
        return
    print(f"\n  Found {len(downloaded)} downloaded file(s) to audit...\n")
    for _, local_path, _ in downloaded:
        audit_file(local_path)


def run_full(manifest):
    print("=" * 62)
    print("  Remnant Biome - LOCA2-Hybrid CA Downloader")
    print("=" * 62)
    print(f"  Models    : {', '.join(MODELS)}")
    print(f"  Scenarios : historical + {', '.join(SCENARIOS)}")
    print(f"  Variables : {', '.join(VARIABLES)}")
    print(f"  Files     : {len(manifest)} total")
    print(f"  Est. size : ~{len(manifest) * 3:.0f} GB")
    print(f"  Output dir: {BASE_DIR.resolve()}")
    print("=" * 62)

    already_done = sum(1 for _, p, _ in manifest if p.exists())
    if already_done:
        print(f"\n  Note: {already_done} file(s) already downloaded and will be skipped.")

    confirm = input("\n  Start full download? (yes/no): ").strip().lower()
    if confirm != "yes":
        print("  Aborted. Use --file N to download one file at a time instead.")
        return

    s3    = make_s3_client()
    total = len(manifest)
    print()
    for i, (key, local_path, label) in enumerate(manifest, 1):
        print(f"[{i}/{total}] {label}")
        download_file(s3, key, local_path)

    print()
    print("  All downloads complete.")
    print(f"  Files saved to: {BASE_DIR.resolve()}")
    print("\n  Next step: python compute_metrics.py --all")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Remnant Biome - LOCA2-Hybrid CA downloader"
    )
    parser.add_argument(
        "--manifest", action="store_true",
        help="List all 60 files with index numbers and download status",
    )
    parser.add_argument(
        "--test", action="store_true",
        help="Download file #1 only and audit it",
    )
    parser.add_argument(
        "--file", type=int, metavar="N",
        help="Download one specific file by index number (see --manifest for numbers)",
    )
    parser.add_argument(
        "--audit", action="store_true",
        help="Audit already-downloaded files without downloading anything",
    )
    args = parser.parse_args()

    manifest = build_manifest()

    if args.manifest:
        run_manifest(manifest)
    elif args.audit:
        run_audit(manifest)
    elif args.test:
        run_test(manifest)
    elif args.file is not None:
        run_file(manifest, args.file)
    else:
        run_full(manifest)


if __name__ == "__main__":
    main()
