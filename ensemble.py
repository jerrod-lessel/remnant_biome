"""
Remnant Biome - Ensemble Aggregation
=====================================
Takes per-model Zarr outputs from compute_metrics.py and computes
ensemble statistics across the 3 CMIP6 models.

Historical period: ensemble mean (single solid line in frontend)
Future scenarios:  median + p10 + p90 (solid line + uncertainty band)

Output structure:
    data/ensemble/
        historical/
            almonds_chill_hours_mean.zarr
            ...
        ssp245/
            almonds_chill_hours_median.zarr
            almonds_chill_hours_p10.zarr
            almonds_chill_hours_p90.zarr
            ...
        ssp370/  (same structure)
        ssp585/  (same structure)

Usage:
    python ensemble.py                    # run all scenarios
    python ensemble.py --scenario ssp245  # run one scenario
    python ensemble.py --check            # verify all outputs exist

Requirements:
    pip install xarray zarr numpy pyyaml
"""

import argparse
import numpy as np
import xarray as xr
import yaml
from pathlib import Path


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PROCESSED_DIR = Path("data/processed")
ENSEMBLE_DIR  = Path("data/ensemble")
METRICS_FILE  = Path("metrics.yaml")

MODELS        = ["EC-Earth3", "MIROC6", "MRI-ESM2-0"]
SCENARIOS     = ["ssp245", "ssp370", "ssp585"]
HIST_SCENARIO = "historical"


# ---------------------------------------------------------------------------
# Config loader
# ---------------------------------------------------------------------------

def load_metrics_config():
    """Load and flatten metrics.yaml into a single dict."""
    with open(METRICS_FILE) as f:
        raw = yaml.safe_load(f)
    metrics = {}
    for section in raw.values():
        metrics.update(section)
    return metrics


# ---------------------------------------------------------------------------
# Core aggregation
# ---------------------------------------------------------------------------

def load_metric_across_models(metric_name, scenario):
    """
    Load one metric from all 3 models for a given scenario.
    Returns a DataArray with a new 'model' dimension stacked on top:
    shape: (model, year, lat, lon)
    """
    arrays = []
    for model in MODELS:
        path = PROCESSED_DIR / model / scenario / f"{metric_name}.zarr"
        if not path.exists():
            raise FileNotFoundError(
                f"Missing: {path}\n"
                f"Run compute_metrics.py --model {model} --scenario {scenario} first."
            )
        ds  = xr.open_zarr(path)
        arr = ds[metric_name]
        arrays.append(arr.expand_dims({"model": [model]}))

    return xr.concat(arrays, dim="model")


def compute_historical_ensemble(stacked):
    """
    For historical: simple mean across models.
    Returns a single DataArray (year, lat, lon).
    """
    return stacked.mean(dim="model")


def compute_future_ensemble(stacked):
    """
    For future scenarios: median, p10, p90 across models.
    Returns a dict of DataArrays each (year, lat, lon).
    """
    return {
        "median": stacked.quantile(0.50, dim="model").drop_vars("quantile"),
        "p10":    stacked.quantile(0.10, dim="model").drop_vars("quantile"),
        "p90":    stacked.quantile(0.90, dim="model").drop_vars("quantile"),
    }


# ---------------------------------------------------------------------------
# Zarr writer
# ---------------------------------------------------------------------------

def save_ensemble_zarr(arr, scenario, metric_name, stat_name, cfg):
    """Save one ensemble statistic to Zarr."""
    out_dir  = ENSEMBLE_DIR / scenario
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{metric_name}_{stat_name}.zarr"

    ds_out = arr.to_dataset(name=metric_name)
    ds_out[metric_name].attrs = {
        "label":       cfg.get("label", metric_name),
        "units":       cfg.get("output_units", ""),
        "category":    cfg.get("category", ""),
        "statistic":   stat_name,
        "models":      ", ".join(MODELS),
        "scenario":    scenario,
    }

    ds_out.to_zarr(out_path, mode="w")
    size_mb = sum(
        f.stat().st_size for f in out_path.rglob("*") if f.is_file()
    ) / 1e6
    print(f"    saved {out_path.name}  ({size_mb:.1f} MB)")


# ---------------------------------------------------------------------------
# Job runners
# ---------------------------------------------------------------------------

def run_historical(metrics):
    """Compute ensemble mean for historical period."""
    print(f"\n{'='*62}")
    print(f"  Ensemble: historical (mean across {len(MODELS)} models)")
    print(f"{'='*62}\n")

    for metric_name, cfg in metrics.items():
        print(f"  {metric_name}...")
        try:
            stacked = load_metric_across_models(metric_name, HIST_SCENARIO)
        except FileNotFoundError as e:
            print(f"    ERROR: {e}")
            continue

        mean_arr = compute_historical_ensemble(stacked)
        save_ensemble_zarr(mean_arr, HIST_SCENARIO, metric_name, "mean", cfg)

    print(f"\n  Done: historical ensemble")


def run_future_scenario(scenario, metrics):
    """Compute median/p10/p90 ensemble for one future scenario."""
    print(f"\n{'='*62}")
    print(f"  Ensemble: {scenario} (median + p10/p90 across {len(MODELS)} models)")
    print(f"{'='*62}\n")

    for metric_name, cfg in metrics.items():
        print(f"  {metric_name}...")
        try:
            stacked = load_metric_across_models(metric_name, scenario)
        except FileNotFoundError as e:
            print(f"    ERROR: {e}")
            continue

        stats = compute_future_ensemble(stacked)
        for stat_name, arr in stats.items():
            save_ensemble_zarr(arr, scenario, metric_name, stat_name, cfg)

    print(f"\n  Done: {scenario} ensemble")


# ---------------------------------------------------------------------------
# Check outputs
# ---------------------------------------------------------------------------

def run_check(metrics):
    """Verify all expected ensemble outputs exist and print a summary."""
    print(f"\n{'='*62}")
    print(f"  Ensemble output check")
    print(f"{'='*62}\n")

    all_ok = True

    # Historical — one mean per metric
    for metric_name in metrics:
        path = ENSEMBLE_DIR / HIST_SCENARIO / f"{metric_name}_mean.zarr"
        status = "OK" if path.exists() else "MISSING"
        if status == "MISSING":
            all_ok = False
        print(f"  historical / {metric_name}_mean: {status}")

    print()

    # Future — median, p10, p90 per metric per scenario
    for scenario in SCENARIOS:
        for metric_name in metrics:
            for stat in ["median", "p10", "p90"]:
                path = ENSEMBLE_DIR / scenario / f"{metric_name}_{stat}.zarr"
                status = "OK" if path.exists() else "MISSING"
                if status == "MISSING":
                    all_ok = False
                print(f"  {scenario} / {metric_name}_{stat}: {status}")
        print()

    if all_ok:
        print("  All ensemble outputs present. Ready for PNG tiling.")
    else:
        print("  Some outputs missing. Run ensemble.py to generate them.")
    print()


# ---------------------------------------------------------------------------
# Quick sanity check on values
# ---------------------------------------------------------------------------

def run_sanity(metrics):
    """
    Print ensemble mean values for almonds chill hours at Fresno
    across all scenarios to verify the spread makes sense.
    """
    print(f"\n{'='*62}")
    print(f"  Sanity check: almond chill hours at Fresno (36.5N, -119.5W)")
    print(f"{'='*62}\n")

    metric = "almonds_chill_hours"

    # Historical mean
    path = ENSEMBLE_DIR / HIST_SCENARIO / f"{metric}_mean.zarr"
    if path.exists():
        ds  = xr.open_zarr(path)
        val = ds[metric].sel(lat=36.5, lon=-119.5, method="nearest")
        print(f"  Historical (ensemble mean):")
        for y, v in zip(val.year.values[::5], val.values[::5]):
            print(f"    {y}: {v:.0f} hrs")
        print()

    # Future scenarios
    for scenario in SCENARIOS:
        path = ENSEMBLE_DIR / scenario / f"{metric}_median.zarr"
        if path.exists():
            ds     = xr.open_zarr(path)
            median = ds[metric].sel(lat=36.5, lon=-119.5, method="nearest")
            p10    = xr.open_zarr(
                ENSEMBLE_DIR / scenario / f"{metric}_p10.zarr"
            )[metric].sel(lat=36.5, lon=-119.5, method="nearest")
            p90    = xr.open_zarr(
                ENSEMBLE_DIR / scenario / f"{metric}_p90.zarr"
            )[metric].sel(lat=36.5, lon=-119.5, method="nearest")

            print(f"  {scenario} (median / p10-p90 band):")
            years  = median.year.values[::10]
            meds   = median.values[::10]
            lows   = p10.values[::10]
            highs  = p90.values[::10]
            for y, m, lo, hi in zip(years, meds, lows, highs):
                print(f"    {y}: {m:.0f} hrs  (band: {lo:.0f}-{hi:.0f})")
            print()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Remnant Biome - ensemble aggregation"
    )
    parser.add_argument(
        "--scenario",
        help="Run one scenario only (historical, ssp245, ssp370, ssp585)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check which ensemble outputs exist",
    )
    parser.add_argument(
        "--sanity",
        action="store_true",
        help="Print spot-check values at Fresno to verify ensemble spread",
    )
    args = parser.parse_args()

    metrics = load_metrics_config()

    if args.check:
        run_check(metrics)
        return

    if args.sanity:
        run_sanity(metrics)
        return

    if args.scenario:
        if args.scenario == HIST_SCENARIO:
            run_historical(metrics)
        elif args.scenario in SCENARIOS:
            run_future_scenario(args.scenario, metrics)
        else:
            print(f"\n  Unknown scenario '{args.scenario}'")
            print(f"  Valid options: historical, {', '.join(SCENARIOS)}\n")
        return

    # No flag — run everything
    run_historical(metrics)
    for scenario in SCENARIOS:
        run_future_scenario(scenario, metrics)

    print(f"\n{'='*62}")
    print(f"  All ensemble outputs complete.")
    print(f"  Run: python ensemble.py --sanity to verify values")
    print(f"  Next step: python tile_pngs.py")
    print(f"{'='*62}\n")


if __name__ == "__main__":
    main()
