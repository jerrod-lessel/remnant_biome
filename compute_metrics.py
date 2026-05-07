"""
Remnant Biome - Metric Computation Pipeline
============================================
Reads raw LOCA2-Hybrid CA NetCDF files, computes all metrics defined
in metrics.yaml, and saves results to Zarr stores under data/processed/.

Usage:
    python compute_metrics.py --model EC-Earth3 --scenario historical
    python compute_metrics.py --model EC-Earth3 --scenario ssp245
    python compute_metrics.py --model EC-Earth3 --scenario historical --delete-raw
    python compute_metrics.py --list-jobs
    python compute_metrics.py --all

Typical one-at-a-time workflow:
    1. python download_loca2.py --file N
    2. python compute_metrics.py --model X --scenario Y --delete-raw
    3. python download_loca2.py --file N+1
    ... repeat

Requirements:
    pip install xarray zarr numpy pyyaml netcdf4
"""

import argparse
import numpy as np
import xarray as xr
import zarr
import yaml
from pathlib import Path


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

RAW_DIR       = Path("data/raw/loca2")
PROCESSED_DIR = Path("data/processed")
METRICS_FILE  = Path("metrics.yaml")

MODELS        = ["EC-Earth3", "MIROC6", "MRI-ESM2-0"]
SCENARIOS     = ["ssp245", "ssp370", "ssp585"]
HIST_SCENARIO = "historical"
RIPF          = "r1i1p1f1"

YEAR_START = 1980
YEAR_END   = 2100


# ---------------------------------------------------------------------------
# Raw file loader
# ---------------------------------------------------------------------------

def load_variable(model, scenario, variable):
    """
    Load all NetCDF chunks for one model/scenario/variable.
    Handles the LOCA2 quirk where tasmin may be named
    'tasmax_minus_tasmax_minus_tasmin' internally — renames it to 'tasmin'.
    Returns a DataArray in Kelvin.
    """
    path = RAW_DIR / model / scenario / variable
    files = sorted(path.glob("*.nc"))
    if not files:
        raise FileNotFoundError(f"No files found at {path}")

    datasets = [xr.open_dataset(f, chunks={"time": 365}) for f in files]
    ds = xr.concat(datasets, dim="time")

    # Normalize variable name — find whatever the file calls it and rename to
    # the standard name (tasmax or tasmin) based on the folder we loaded from
    actual_vars = list(ds.data_vars)
    if variable not in actual_vars:
        # File uses a non-standard name — rename the first data var to what we expect
        old_name = actual_vars[0]
        print(f"    Note: renaming '{old_name}' to '{variable}'")
        ds = ds.rename({old_name: variable})

    return ds[variable]


def load_model_scenario(model, scenario):
    """
    Load and concatenate tasmax + tasmin for a model/scenario into a single
    Dataset. For future scenarios, prepends historical so we get a continuous
    1950-2100 timeseries. Converts Kelvin to Celsius. Normalizes longitudes.
    Slices to YEAR_START-YEAR_END.
    """
    def get_chunks(m, s):
        tmax = load_variable(m, s, "tasmax")
        tmin = load_variable(m, s, "tasmin")
        return xr.Dataset({"tasmax": tmax, "tasmin": tmin})

    print(f"  Loading {model} / historical...")
    ds_hist = get_chunks(model, HIST_SCENARIO)

    if scenario == HIST_SCENARIO:
        ds = ds_hist
    else:
        print(f"  Loading {model} / {scenario}...")
        ds_fut = get_chunks(model, scenario)
        ds = xr.concat([ds_hist, ds_fut], dim="time")

    # Convert Kelvin to Celsius once here, never again
    print(f"  Converting Kelvin to Celsius...")
    ds["tasmax"] = ds["tasmax"] - 273.15
    ds["tasmin"] = ds["tasmin"] - 273.15
    ds["tasmax"].attrs["units"] = "C"
    ds["tasmin"].attrs["units"] = "C"

    # Normalize 0-360 longitudes to -180/180 if needed
    if float(ds["lon"].max()) > 180:
        print(f"  Normalizing longitudes...")
        ds = ds.assign_coords(lon=(ds["lon"] + 180) % 360 - 180)
        ds = ds.sortby("lon")

    # Slice to our year range
    ds = ds.sel(time=slice(str(YEAR_START), str(YEAR_END)))

    n_days  = ds.sizes["time"]
    lat_min = float(ds.lat.min())
    lat_max = float(ds.lat.max())
    lon_min = float(ds.lon.min())
    lon_max = float(ds.lon.max())
    print(f"  Ready: {n_days} days | "
          f"lat {lat_min:.2f}-{lat_max:.2f} | "
          f"lon {lon_min:.2f}-{lon_max:.2f}")

    return ds


# ---------------------------------------------------------------------------
# Metric primitive functions
# Each returns a DataArray with dims (year, lat, lon)
# ---------------------------------------------------------------------------

def compute_chill_hours(ds, cfg):
    """
    Estimate seasonal chill hours from daily Tmax/Tmin.
    Simple min/max proxy: linear interpolation of hours below threshold
    based on where threshold falls between Tmin and Tmax.
    Clipped to [0, 24] hours per day.
    Season labeled by January year (Nov/Dec roll forward to next year).
    """
    threshold = cfg["threshold_c"]
    months    = cfg["months"]
    tmax      = ds["tasmax"]
    tmin      = ds["tasmin"]

    # Fraction of day below threshold, scaled to hours
    daily_chill_hrs = ((threshold - tmin) / (tmax - tmin)).clip(0, 1) * 24.0

    # Zero out days outside the season
    in_season       = ds["time"].dt.month.isin(months)
    daily_chill_hrs = daily_chill_hrs.where(in_season, 0.0)

    # Label Nov/Dec as belonging to the next year's winter season
    time        = ds["time"]
    season_year = xr.where(time.dt.month >= 11, time.dt.year + 1, time.dt.year)
    daily_chill_hrs = daily_chill_hrs.assign_coords(
        season_year=("time", season_year.values)
    )

    return daily_chill_hrs.groupby("season_year").sum(dim="time").rename(
        {"season_year": "year"}
    )


def compute_degree_days(ds, cfg):
    """
    Accumulated degree days above base temperature.
    DD per day = max(0, (Tmax + Tmin) / 2 - base_c)
    Summed over specified months per calendar year.
    """
    base      = cfg["base_c"]
    months    = cfg["months"]
    tmean     = (ds["tasmax"] + ds["tasmin"]) / 2.0
    daily_dd  = (tmean - base).clip(min=0)
    in_season = ds["time"].dt.month.isin(months)
    daily_dd  = daily_dd.where(in_season, 0.0)
    return daily_dd.groupby("time.year").sum(dim="time")


def compute_threshold_days(ds, cfg):
    """
    Count days where a temperature variable crosses a threshold.
    operator: 'below' counts days where temp < threshold
              'above' counts days where temp > threshold
    Winter metrics labeled by January year.
    """
    threshold    = cfg["threshold_c"]
    variable     = cfg["variable"]
    operator     = cfg["operator"]
    months       = cfg["months"]
    season_label = cfg.get("season_label", "annual")
    temp         = ds[variable]

    daily_flag = (temp < threshold).astype(float) if operator == "below" \
            else (temp > threshold).astype(float)

    if months != "all":
        in_season  = ds["time"].dt.month.isin(months)
        daily_flag = daily_flag.where(in_season, 0.0)

    if season_label == "winter":
        time        = ds["time"]
        season_year = xr.where(
            time.dt.month >= 11, time.dt.year + 1, time.dt.year
        )
        daily_flag = daily_flag.assign_coords(
            season_year=("time", season_year.values)
        )
        return daily_flag.groupby("season_year").sum(dim="time").rename(
            {"season_year": "year"}
        )

    return daily_flag.groupby("time.year").sum(dim="time")


# ---------------------------------------------------------------------------
# Metric dispatcher
# ---------------------------------------------------------------------------

METRIC_FUNCTIONS = {
    "chill_hours":    compute_chill_hours,
    "degree_days":    compute_degree_days,
    "threshold_days": compute_threshold_days,
}


def compute_metric(ds, metric_name, cfg):
    metric_type = cfg["type"]
    if metric_type not in METRIC_FUNCTIONS:
        raise ValueError(f"Unknown metric type '{metric_type}' for '{metric_name}'")
    print(f"  Computing {metric_name} ({metric_type})...")
    return METRIC_FUNCTIONS[metric_type](ds, cfg)


# ---------------------------------------------------------------------------
# Zarr writer
# ---------------------------------------------------------------------------

def save_to_zarr(result, model, scenario, metric_name, cfg):
    """Save a computed (year, lat, lon) DataArray to Zarr."""
    out_dir  = PROCESSED_DIR / model / scenario
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{metric_name}.zarr"

    ds_out = result.to_dataset(name=metric_name)
    ds_out[metric_name].attrs = {
        "label":            cfg.get("label", metric_name),
        "units":            cfg.get("output_units", ""),
        "type":             cfg.get("type", ""),
        "threshold_c":      str(cfg.get("threshold_c", "")),
        "base_c":           str(cfg.get("base_c", "")),
        "months":           str(cfg.get("months", "all")),
        "viability_min":    str(cfg.get("viability_min", "")),
        "viability_max":    str(cfg.get("viability_max", "")),
        "category":         cfg.get("category", ""),
        "model":            model,
        "scenario":         scenario,
    }

    ds_out.to_zarr(out_path, mode="w")
    size_mb = sum(
        f.stat().st_size for f in out_path.rglob("*") if f.is_file()
    ) / 1e6
    print(f"  Saved: {out_path.name}  ({size_mb:.1f} MB)")


# ---------------------------------------------------------------------------
# Delete raw files
# ---------------------------------------------------------------------------

def delete_raw_files(model, scenario):
    """Delete raw NetCDF files for a model/scenario to free disk space."""
    # For future scenarios we also need historical loaded — but historical
    # files may be shared across scenarios so we only delete the scenario
    # folder itself, not historical unless explicitly running historical job
    raw_path = RAW_DIR / model / scenario
    if not raw_path.exists():
        print(f"  Nothing to delete at {raw_path}")
        return

    files = list(raw_path.rglob("*.nc"))
    if not files:
        print(f"  No .nc files found at {raw_path}")
        return

    total_gb = sum(f.stat().st_size for f in files) / 1e9
    print(f"\n  About to delete {len(files)} file(s) ({total_gb:.1f} GB):")
    for f in files:
        print(f"    {f.name}")

    confirm = input("\n  Confirm delete? (yes/no): ").strip().lower()
    if confirm == "yes":
        for f in files:
            f.unlink()
        print(f"  Deleted. Recovered ~{total_gb:.1f} GB.")
    else:
        print("  Aborted — files kept.")


# ---------------------------------------------------------------------------
# Config loader
# ---------------------------------------------------------------------------

def load_metrics_config():
    """Load and flatten metrics.yaml crops + pests into one dict."""
    with open(METRICS_FILE) as f:
        raw = yaml.safe_load(f)
    metrics = {}
    for section in raw.values():
        metrics.update(section)
    return metrics


# ---------------------------------------------------------------------------
# Job runner
# ---------------------------------------------------------------------------

def list_jobs():
    print("\n  Available jobs:")
    print(f"  {'#':<4} {'MODEL':<15} {'SCENARIO'}")
    print(f"  {'-'*4} {'-'*15} {'-'*12}")
    i = 1
    for model in MODELS:
        for scenario in [HIST_SCENARIO] + SCENARIOS:
            print(f"  {i:<4} {model:<15} {scenario}")
            i += 1
    print()


def run_job(model, scenario, metrics):
    print(f"\n{'='*62}")
    print(f"  Job: {model} / {scenario}")
    print(f"{'='*62}\n")

    try:
        ds = load_model_scenario(model, scenario)
    except FileNotFoundError as e:
        print(f"\n  ERROR: {e}")
        print(f"  Run: python download_loca2.py --manifest to check what's downloaded.")
        return False

    print()
    for metric_name, cfg in metrics.items():
        result = compute_metric(ds, metric_name, cfg)
        save_to_zarr(result, model, scenario, metric_name, cfg)

    print(f"\n  Done: {model} / {scenario}")
    print(f"  Outputs: {PROCESSED_DIR / model / scenario}")
    return True


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Remnant Biome - metric computation pipeline"
    )
    parser.add_argument("--model",      help="Model name e.g. EC-Earth3")
    parser.add_argument("--scenario",   help="Scenario e.g. ssp245 or historical")
    parser.add_argument("--all",        action="store_true", help="Run all jobs")
    parser.add_argument("--list-jobs",  action="store_true", help="List all jobs")
    parser.add_argument("--delete-raw", action="store_true",
                        help="Delete raw NetCDF files after computing metrics")
    args = parser.parse_args()

    metrics = load_metrics_config()

    if args.list_jobs:
        list_jobs()
        return

    if args.all:
        for model in MODELS:
            for scenario in [HIST_SCENARIO] + SCENARIOS:
                ok = run_job(model, scenario, metrics)
                if not ok:
                    print(f"  Stopping — missing files for {model}/{scenario}.")
                    break
        return

    if args.model and args.scenario:
        ok = run_job(args.model, args.scenario, metrics)
        if ok and args.delete_raw:
            delete_raw_files(args.model, args.scenario)
        return

    parser.print_help()
    print("\n  Examples:")
    print("    python compute_metrics.py --list-jobs")
    print("    python compute_metrics.py --model EC-Earth3 --scenario historical")
    print("    python compute_metrics.py --model EC-Earth3 --scenario historical --delete-raw")


if __name__ == "__main__":
    main()
