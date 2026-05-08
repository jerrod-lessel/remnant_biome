"""
Remnant Biome - Recompute Changed Metrics
==========================================
Recomputes avocado_hard_freeze_days and vine_mealybug_development_days
across all 12 model/scenario jobs.

Safety features:
  - Verifies ALL required raw files exist and are complete before processing
  - Only processes jobs where raw files are fully present
  - Will not write partial/corrupted output

Usage:
    python recompute_changed_metrics.py
    python recompute_changed_metrics.py --check   # check raw file status only

Requirements: same as compute_metrics.py
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
ENSEMBLE_DIR  = Path("data/ensemble")
METRICS_FILE  = Path("metrics.yaml")

MODELS        = ["EC-Earth3", "MIROC6", "MRI-ESM2-0"]
SCENARIOS     = ["ssp245", "ssp370", "ssp585"]
HIST_SCENARIO = "historical"
YEAR_START    = 1980
YEAR_END      = 2100

# Minimum expected file sizes in bytes (rough lower bound)
# Historical ~6GB, future chunks ~2.4GB minimum
MIN_HIST_SIZE  = 5_000_000_000   # 5GB
MIN_FUT_SIZE   = 2_000_000_000   # 2GB

TARGET_METRICS = ["avocado_hard_freeze_days", "vine_mealybug_development_days"]


# ---------------------------------------------------------------------------
# File size verification
# ---------------------------------------------------------------------------

def verify_raw_files(model, scenario):
    """
    Check that all raw NetCDF files for a model/scenario exist and are
    at least the minimum expected size. Returns (ok, message).
    """
    # Always need historical
    hist_tasmax = RAW_DIR / model / HIST_SCENARIO / "tasmax"
    hist_tasmin = RAW_DIR / model / HIST_SCENARIO / "tasmin"

    for folder, min_size in [(hist_tasmax, MIN_HIST_SIZE), (hist_tasmin, MIN_HIST_SIZE)]:
        files = list(folder.glob("*.nc"))
        if not files:
            return False, f"Missing historical raw files at {folder}"
        for f in files:
            if f.stat().st_size < min_size:
                return False, f"File too small (likely incomplete download): {f.name} ({f.stat().st_size / 1e9:.1f}GB)"

    # For future scenarios also check scenario files
    if scenario != HIST_SCENARIO:
        for variable in ["tasmax", "tasmin"]:
            folder = RAW_DIR / model / scenario / variable
            files  = list(folder.glob("*.nc"))
            if not files:
                return False, f"Missing {scenario} raw files at {folder}"
            for f in files:
                if f.stat().st_size < MIN_FUT_SIZE:
                    return False, f"File too small (likely incomplete): {f.name} ({f.stat().st_size / 1e9:.1f}GB)"

    return True, "OK"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_metrics_config():
    with open(METRICS_FILE) as f:
        raw = yaml.safe_load(f)
    metrics = {}
    for section in raw.values():
        metrics.update(section)
    return metrics


def load_variable(model, scenario, variable):
    path  = RAW_DIR / model / scenario / variable
    files = sorted(path.glob("*.nc"))
    if not files:
        raise FileNotFoundError(f"No files found at {path}")
    datasets = [xr.open_dataset(f, chunks={"time": 365}) for f in files]
    ds = xr.concat(datasets, dim="time")
    actual_vars = list(ds.data_vars)
    if variable not in actual_vars:
        old_name = actual_vars[0]
        print(f"    Note: renaming '{old_name}' to '{variable}'")
        ds = ds.rename({old_name: variable})
    return ds[variable]


def load_model_scenario(model, scenario):
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

    ds["tasmax"] = ds["tasmax"] - 273.15
    ds["tasmin"] = ds["tasmin"] - 273.15
    ds["tasmax"].attrs["units"] = "C"
    ds["tasmin"].attrs["units"] = "C"

    if float(ds["lon"].max()) > 180:
        ds = ds.assign_coords(lon=(ds["lon"] + 180) % 360 - 180)
        ds = ds.sortby("lon")

    ds = ds.sel(time=slice(str(YEAR_START), str(YEAR_END)))
    print(f"  Ready: {ds.sizes['time']} days")
    return ds


def compute_threshold_days(ds, cfg):
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


def save_to_zarr(result, model, scenario, metric_name, cfg):
    out_dir  = PROCESSED_DIR / model / scenario
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{metric_name}.zarr"
    ds_out   = result.to_dataset(name=metric_name)
    ds_out[metric_name].attrs = {
        "label":       cfg.get("label", metric_name),
        "units":       cfg.get("output_units", ""),
        "type":        cfg.get("type", ""),
        "threshold_c": str(cfg.get("threshold_c", "")),
        "months":      str(cfg.get("months", "all")),
        "category":    cfg.get("category", ""),
        "model":       model,
        "scenario":    scenario,
    }
    ds_out.to_zarr(out_path, mode="w")
    size_mb = sum(
        f.stat().st_size for f in out_path.rglob("*") if f.is_file()
    ) / 1e6
    print(f"    saved {out_path.name}  ({size_mb:.1f} MB)")


# ---------------------------------------------------------------------------
# Ensemble
# ---------------------------------------------------------------------------

def load_metric_across_models(metric_name, scenario):
    arrays = []
    for model in MODELS:
        path = PROCESSED_DIR / model / scenario / f"{metric_name}.zarr"
        if not path.exists():
            raise FileNotFoundError(f"Missing: {path}")
        ds  = xr.open_zarr(path)
        arr = ds[metric_name]
        arrays.append(arr.expand_dims({"model": [model]}))
    return xr.concat(arrays, dim="model", join="override")


def save_ensemble_zarr(arr, scenario, metric_name, stat_name, cfg):
    out_dir  = ENSEMBLE_DIR / scenario
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{metric_name}_{stat_name}.zarr"
    ds_out   = arr.to_dataset(name=metric_name)
    ds_out[metric_name].attrs = {
        "label":     cfg.get("label", metric_name),
        "units":     cfg.get("output_units", ""),
        "statistic": stat_name,
        "models":    ", ".join(MODELS),
        "scenario":  scenario,
    }
    ds_out.to_zarr(out_path, mode="w")
    size_mb = sum(
        f.stat().st_size for f in out_path.rglob("*") if f.is_file()
    ) / 1e6
    print(f"    saved {out_path.name}  ({size_mb:.1f} MB)")


# ---------------------------------------------------------------------------
# Check mode
# ---------------------------------------------------------------------------

def run_check():
    """Print raw file status for all model/scenario combos."""
    print(f"\n{'='*62}")
    print(f"  Raw file check for recompute")
    print(f"{'='*62}\n")
    all_scenarios = [HIST_SCENARIO] + SCENARIOS
    for model in MODELS:
        for scenario in all_scenarios:
            ok, msg = verify_raw_files(model, scenario)
            status = "READY" if ok else f"MISSING - {msg}"
            print(f"  {model} / {scenario}: {status}")
    print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true",
                        help="Check raw file status without computing")
    args = parser.parse_args()

    if args.check:
        run_check()
        return

    metrics     = load_metrics_config()
    target_cfg  = {k: v for k, v in metrics.items() if k in TARGET_METRICS}

    print(f"\nTarget metrics: {list(target_cfg.keys())}")
    if len(target_cfg) != len(TARGET_METRICS):
        missing = set(TARGET_METRICS) - set(target_cfg.keys())
        print(f"\nWARNING: These metrics not found in metrics.yaml: {missing}")
        print("Check that metrics.yaml has been updated with the new names.")
        return

    all_scenarios = [HIST_SCENARIO] + SCENARIOS
    completed_jobs = []

    # --- Step 1: Per-model Zarr stores ---
    for model in MODELS:
        for scenario in all_scenarios:
            print(f"\n{'='*62}")
            print(f"  {model} / {scenario}")
            print(f"{'='*62}")

            ok, msg = verify_raw_files(model, scenario)
            if not ok:
                print(f"  SKIP: {msg}")
                continue

            try:
                ds = load_model_scenario(model, scenario)
            except Exception as e:
                print(f"  ERROR loading data: {e}")
                continue

            for metric_name, cfg in target_cfg.items():
                print(f"  Computing {metric_name}...")
                result = compute_threshold_days(ds, cfg)
                save_to_zarr(result, model, scenario, metric_name, cfg)

            completed_jobs.append((model, scenario))

    print(f"\n  Completed {len(completed_jobs)} jobs.")

    # Check if all 12 jobs are done before running ensemble
    all_done = all(
        (PROCESSED_DIR / model / scenario / f"{m}.zarr").exists()
        for model in MODELS
        for scenario in all_scenarios
        for m in TARGET_METRICS
    )

    if not all_done:
        print(f"\n  Not all jobs complete yet — skipping ensemble aggregation.")
        print(f"  Re-download missing raw files and run again.")
        # Show what's still missing
        print(f"\n  Missing zarrs:")
        for model in MODELS:
            for scenario in all_scenarios:
                for m in TARGET_METRICS:
                    p = PROCESSED_DIR / model / scenario / f"{m}.zarr"
                    if not p.exists():
                        print(f"    {model}/{scenario}/{m}")
        return

    # --- Step 2: Ensemble aggregation ---
    print(f"\n{'='*62}")
    print(f"  Recomputing ensemble for changed metrics")
    print(f"{'='*62}\n")

    for metric_name, cfg in target_cfg.items():
        print(f"  historical / {metric_name}...")
        stacked  = load_metric_across_models(metric_name, HIST_SCENARIO)
        mean_arr = stacked.mean(dim="model")
        save_ensemble_zarr(mean_arr, HIST_SCENARIO, metric_name, "mean", cfg)

    for scenario in SCENARIOS:
        for metric_name, cfg in target_cfg.items():
            print(f"  {scenario} / {metric_name}...")
            stacked = load_metric_across_models(metric_name, scenario)
            for stat, q in [("median", 0.50), ("p10", 0.10), ("p90", 0.90)]:
                arr = stacked.quantile(q, dim="model").drop_vars("quantile")
                save_ensemble_zarr(arr, scenario, metric_name, stat, cfg)

    print(f"\n{'='*62}")
    print(f"  All done! Both metrics recomputed and ensemble updated.")
    print(f"{'='*62}\n")


if __name__ == "__main__":
    main()
