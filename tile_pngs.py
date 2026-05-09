"""
Remnant Biome - PNG Tiling Pipeline
=====================================
Converts ensemble Zarr stores into PNG images for MapLibre display.

One PNG per metric x year x scenario (median only for map display).
p10/p90 stay in Zarr for click-point timeline charts.

Output structure:
    pngs/
        almonds_chill_hours/
            historical_1980.png
            historical_1981.png
            ...
            ssp245_2015.png
            ssp370_2015.png
            ssp585_2015.png
        wine_grapes_gdd/
            ...
        ...

Also generates:
    pngs/metadata.json   - color ramps, thresholds, year ranges for frontend

Usage:
    python tile_pngs.py                        # tile all metrics
    python tile_pngs.py --metric almonds_chill_hours  # one metric only
    python tile_pngs.py --check                # verify all PNGs exist
    python tile_pngs.py --dry-run              # print what would be generated

Requirements:
    pip install xarray zarr numpy pillow geopandas pyproj shapely requests
"""

import argparse
import json
import numpy as np
import xarray as xr
from pathlib import Path
from PIL import Image

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ENSEMBLE_DIR = Path("data/ensemble")
PNG_DIR      = Path("pngs")

SCENARIOS     = ["ssp245", "ssp370", "ssp585"]
HIST_SCENARIO = "historical"

HIST_YEARS   = list(range(1980, 2015))   # 1980-2014
FUTURE_YEARS = list(range(2015, 2101))   # 2015-2100
ALL_YEARS    = HIST_YEARS + FUTURE_YEARS

# California bounding box in the data's coordinate system
# Data uses 0-360 longitudes so we keep that here, convert at load time
CA_LAT_MIN, CA_LAT_MAX = 32.5, 42.0
CA_LON_MIN, CA_LON_MAX = -124.5, -114.1

# ---------------------------------------------------------------------------
# Color definitions
# ---------------------------------------------------------------------------

# Three-state colors as RGBA tuples
GREEN  = (74,  222, 128, 255)   # #4ade80 - viable
AMBER  = (245, 158,  58, 255)   # #f59e3a - marginal
RED    = (248, 113, 113, 255)   # #f87171 - deficit/risk
TRANSP = (0,   0,   0,   0)     # transparent - outside CA or no data

# ---------------------------------------------------------------------------
# Metric color ramp definitions
# Each metric defines a function: value -> RGBA
# ---------------------------------------------------------------------------

def color_almonds_chill_hours(val):
    if np.isnan(val): return TRANSP
    if val >= 500:    return GREEN
    if val >= 400:    return AMBER
    return RED

def color_wine_grapes_chill_hours(val):
    if np.isnan(val): return TRANSP
    if val >= 200:    return GREEN
    if val >= 150:    return AMBER
    return RED

def color_wine_grapes_gdd(val):
    # U-shaped: green in middle, red on both ends
    if np.isnan(val): return TRANSP
    if 1200 <= val <= 2500: return GREEN
    if 1000 <= val < 1200:  return AMBER
    if 2500 < val <= 2900:  return AMBER
    return RED  # below 1000 or above 2900

def color_navel_orange_frost_days(val):
    # Lower = better (fewer frost days)
    if np.isnan(val): return TRANSP
    if val == 0:      return GREEN
    if val <= 2:      return AMBER
    return RED

def color_avocado_hard_freeze_days(val):
    if np.isnan(val): return TRANSP
    if val == 0:      return GREEN
    if val <= 1:      return AMBER
    return RED

def color_navel_orangeworm_dd(val):
    # Higher = worse (more pest pressure)
    if np.isnan(val): return TRANSP
    if val < 600:     return GREEN
    if val <= 800:    return AMBER
    return RED

def color_vine_mealybug_development_days(val):
    # Higher = worse (more winter development days)
    if np.isnan(val): return TRANSP
    if val < 10:      return GREEN
    if val <= 20:     return AMBER
    return RED

def color_spotted_wing_drosophila_mortality(val):
    # Lower = worse (fewer cold mortality days = wider range)
    if np.isnan(val): return TRANSP
    if val > 5:       return GREEN
    if val >= 2:      return AMBER
    return RED

COLOR_FUNCTIONS = {
    "almonds_chill_hours":               color_almonds_chill_hours,
    "wine_grapes_chill_hours":           color_wine_grapes_chill_hours,
    "wine_grapes_gdd":                   color_wine_grapes_gdd,
    "navel_orange_frost_days":           color_navel_orange_frost_days,
    "avocado_hard_freeze_days":          color_avocado_hard_freeze_days,
    "navel_orangeworm_dd":               color_navel_orangeworm_dd,
    "vine_mealybug_development_days":    color_vine_mealybug_development_days,
    "spotted_wing_drosophila_mortality": color_spotted_wing_drosophila_mortality,
}

# ---------------------------------------------------------------------------
# California mask
# ---------------------------------------------------------------------------

_ca_mask_cache = None

def get_ca_mask(lat_vals, lon_vals):
    """
    Returns a boolean 2D array (lat x lon) where True = inside California.
    Uses a shapefile from Natural Earth via geopandas.
    Falls back to simple bounding box if geopandas unavailable.
    """
    global _ca_mask_cache
    if _ca_mask_cache is not None:
        return _ca_mask_cache

    try:
        import geopandas as gpd
        from shapely.geometry import Point
        from shapely.vectorized import contains

        print("  Building California mask from shapefile...")

        # Download US states from Natural Earth
        url = "https://naciscdn.org/naturalearth/110m/cultural/ne_110m_admin_1_states_provinces.zip"
        states = gpd.read_file(url)
        ca = states[states["name"] == "California"].geometry.iloc[0]

        # Build mask
        lon_grid, lat_grid = np.meshgrid(lon_vals, lat_vals)
        mask = contains(ca, lon_grid.ravel(), lat_grid.ravel()).reshape(lat_grid.shape)

        print(f"  CA mask built: {mask.sum()} of {mask.size} pixels inside California")
        _ca_mask_cache = mask
        return mask

    except Exception as e:
        print(f"  Warning: geopandas mask failed ({e}), falling back to bounding box")
        lon_grid, lat_grid = np.meshgrid(lon_vals, lat_vals)
        mask = (
            (lat_grid >= CA_LAT_MIN) & (lat_grid <= CA_LAT_MAX) &
            (lon_grid >= CA_LON_MIN) & (lon_grid <= CA_LON_MAX)
        )
        _ca_mask_cache = mask
        return mask

# ---------------------------------------------------------------------------
# Zarr loader
# ---------------------------------------------------------------------------

def load_zarr_metric(metric_name, scenario, stat="median"):
    """
    Load one ensemble zarr. For historical use 'mean', for future use 'median'.
    Returns xarray DataArray with dims (year, lat, lon).
    """
    stat_name = "mean" if scenario == HIST_SCENARIO else stat
    path = ENSEMBLE_DIR / scenario / f"{metric_name}_{stat_name}.zarr"

    if not path.exists():
        raise FileNotFoundError(f"Missing ensemble zarr: {path}")

    ds  = xr.open_zarr(path)
    arr = ds[metric_name]

    # Normalize longitudes from 0-360 to -180/180 if needed
    if float(arr.lon.max()) > 180:
        arr = arr.assign_coords(lon=(arr.lon + 180) % 360 - 180)
        arr = arr.sortby("lon")

    return arr

# ---------------------------------------------------------------------------
# PNG renderer
# ---------------------------------------------------------------------------

def render_png(data_2d, ca_mask, color_fn):
    """
    Convert a 2D numpy array (lat x lon) to a PIL RGBA image.
    Pixels outside CA mask are transparent.
    NaN pixels are transparent.
    """
    h, w = data_2d.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)

    for i in range(h):
        for j in range(w):
            if not ca_mask[i, j]:
                rgba[i, j] = TRANSP
            else:
                val = data_2d[i, j]
                rgba[i, j] = color_fn(float(val))

    return Image.fromarray(rgba, mode="RGBA")

def render_png_fast(data_2d, ca_mask, color_fn):
    """
    Vectorized PNG renderer — much faster than pixel-by-pixel loop.
    Classifies all pixels at once using numpy operations.
    """
    h, w = data_2d.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)

    # Start with all transparent
    # Apply color function per threshold band
    # This works for all our metrics by applying conditions in priority order

    metric_name = color_fn.__name__.replace("color_", "")

    # Default: transparent
    result = np.zeros((h, w, 4), dtype=np.uint8)

    val = data_2d.copy()
    nan_mask = np.isnan(val)

    # Route to the right classification
    if "almonds_chill_hours" in metric_name or "wine_grapes_chill_hours" in metric_name:
        threshold_high = 500 if "almond" in metric_name else 200
        threshold_low  = 400 if "almond" in metric_name else 150
        result[val >= threshold_high] = GREEN
        result[(val >= threshold_low) & (val < threshold_high)] = AMBER
        result[val < threshold_low] = RED

    elif "wine_grapes_gdd" in metric_name:
        result[val < 1000]  = RED
        result[val > 2900]  = RED
        result[(val >= 1000) & (val < 1200)] = AMBER
        result[(val > 2500) & (val <= 2900)] = AMBER
        result[(val >= 1200) & (val <= 2500)] = GREEN

    elif "navel_orange_frost" in metric_name:
        result[val > 2]  = RED
        result[(val > 0) & (val <= 2)] = AMBER
        result[val == 0] = GREEN

    elif "avocado" in metric_name:
        result[val > 1]  = RED
        result[val == 1] = AMBER
        result[val == 0] = GREEN

    elif "orangeworm" in metric_name:
        result[val >= 800] = RED
        result[(val >= 600) & (val < 800)] = AMBER
        result[val < 600]  = GREEN

    elif "vine_mealybug" in metric_name:
        result[val > 20]  = RED
        result[(val >= 10) & (val <= 20)] = AMBER
        result[val < 10]  = GREEN

    elif "spotted_wing" in metric_name:
        result[val < 2]  = RED
        result[(val >= 2) & (val <= 5)] = AMBER
        result[val > 5]  = GREEN

    # Apply masks: NaN and outside-CA both become transparent
    result[nan_mask]   = TRANSP
    result[~ca_mask]   = TRANSP

    return Image.fromarray(result, mode="RGBA")

# ---------------------------------------------------------------------------
# Tile one metric
# ---------------------------------------------------------------------------

def tile_metric(metric_name, force=False):
    """Generate all PNGs for one metric across all scenarios and years."""

    if metric_name not in COLOR_FUNCTIONS:
        print(f"  ERROR: No color function defined for '{metric_name}'")
        return

    color_fn  = COLOR_FUNCTIONS[metric_name]
    out_dir   = PNG_DIR / metric_name
    out_dir.mkdir(parents=True, exist_ok=True)

    # Count existing files
    existing = len(list(out_dir.glob("*.png")))
    expected = len(HIST_YEARS) + len(FUTURE_YEARS) * len(SCENARIOS)

    if existing == expected and not force:
        print(f"  {metric_name}: {existing}/{expected} PNGs already exist, skipping")
        return

    print(f"\n  {metric_name}")
    print(f"  {'─'*50}")

    # Load all scenarios into memory once
    print(f"  Loading zarr data...")
    try:
        hist_arr = load_zarr_metric(metric_name, HIST_SCENARIO)
        fut_arrs = {s: load_zarr_metric(metric_name, s) for s in SCENARIOS}
    except FileNotFoundError as e:
        print(f"  ERROR: {e}")
        return

    # Get coordinate arrays (same for all scenarios)
    lat_vals = hist_arr.lat.values
    lon_vals = hist_arr.lon.values

    # Build CA mask once per metric (same grid for all)
    ca_mask = get_ca_mask(lat_vals, lon_vals)

    total_pngs = 0

    # Historical years
    print(f"  Rendering historical ({len(HIST_YEARS)} years)...")
    for year in HIST_YEARS:
        out_path = out_dir / f"historical_{year}.png"
        if out_path.exists() and not force:
            continue
        try:
            data_2d = hist_arr.sel(year=year).values.astype(np.float32)
            img = render_png_fast(data_2d, ca_mask, color_fn)
            img.save(out_path, optimize=True)
            total_pngs += 1
        except Exception as e:
            print(f"    ERROR year {year}: {e}")

    # Future years per scenario
    for scenario, arr in fut_arrs.items():
        years_in_zarr = arr.year.values
        scenario_years = [y for y in FUTURE_YEARS if y in years_in_zarr]
        print(f"  Rendering {scenario} ({len(scenario_years)} years)...")
        for year in scenario_years:
            out_path = out_dir / f"{scenario}_{year}.png"
            if out_path.exists() and not force:
                continue
            try:
                data_2d = arr.sel(year=year).values.astype(np.float32)
                img = render_png_fast(data_2d, ca_mask, color_fn)
                img.save(out_path, optimize=True)
                total_pngs += 1
            except Exception as e:
                print(f"    ERROR year {year}: {e}")

    final_count = len(list(out_dir.glob("*.png")))
    print(f"  Done: {final_count}/{expected} PNGs  ({total_pngs} new)")

# ---------------------------------------------------------------------------
# Metadata JSON
# ---------------------------------------------------------------------------

def generate_metadata():
    """
    Generate pngs/metadata.json — single source of truth for the frontend.
    Contains color ramp breakpoints, viability thresholds, year ranges,
    scenario labels, and metric display config.
    """
    metadata = {
        "generated": str(Path(".").resolve()),
        "year_ranges": {
            "historical": {"start": HIST_YEARS[0],   "end": HIST_YEARS[-1]},
            "future":     {"start": FUTURE_YEARS[0], "end": FUTURE_YEARS[-1]},
            "all":        {"start": ALL_YEARS[0],    "end": ALL_YEARS[-1]},
        },
        "scenarios": {
            "historical": {
                "label":       "Historical",
                "ssp_code":    None,
                "description": "Observed climate 1980–2014",
                "color":       "#94a3b8",
            },
            "ssp245": {
                "label":       "Current Policy",
                "ssp_code":    "SSP2-4.5",
                "description": "Moderate emissions reduction",
                "color":       "#4ade80",
            },
            "ssp370": {
                "label":       "High Emissions",
                "ssp_code":    "SSP3-7.0",
                "description": "Limited climate action",
                "color":       "#f59e3a",
            },
            "ssp585": {
                "label":       "Worst Case",
                "ssp_code":    "SSP5-8.5",
                "description": "Fossil-fuel intensive development",
                "color":       "#f87171",
            },
        },
        "colors": {
            "viable":   {"hex": "#4ade80", "label": "Viable"},
            "marginal": {"hex": "#f59e3a", "label": "Marginal"},
            "deficit":  {"hex": "#f87171", "label": "Deficit / Risk"},
        },
        "metrics": {
            "almonds_chill_hours": {
                "label":        "Almond Chill Hours",
                "category":     "crop",
                "units":        "hours",
                "direction":    "higher_is_better",
                "thresholds": {
                    "green_min":  500,
                    "amber_min":  400,
                    "red_max":    400,
                },
                "viability_line": 400,
                "chart_label":  "Chill Hours (hrs)",
                "description":  "Hours below 7.2°C (45°F), Nov–Feb. Almonds need ~400hrs of cold for dormancy.",
                "source":       "UC ANR / Nonpareil variety requirement",
            },
            "wine_grapes_chill_hours": {
                "label":        "Wine Grape Chill Hours",
                "category":     "crop",
                "units":        "hours",
                "direction":    "higher_is_better",
                "thresholds": {
                    "green_min":  200,
                    "amber_min":  150,
                    "red_max":    150,
                },
                "viability_line": 150,
                "chart_label":  "Chill Hours (hrs)",
                "description":  "Hours below 7.2°C (45°F), Nov–Feb. Grapes need cold to break dormancy and bloom evenly.",
                "source":       "Luedeling et al. (2009)",
            },
            "wine_grapes_gdd": {
                "label":        "Wine Grape Growing Degree Days",
                "category":     "crop",
                "units":        "GDD",
                "direction":    "middle_is_better",
                "thresholds": {
                    "green_min":  1200,
                    "green_max":  2500,
                    "amber_low_min":  1000,
                    "amber_low_max":  1200,
                    "amber_high_min": 2500,
                    "amber_high_max": 2900,
                    "red_low_max":    1000,
                    "red_high_min":   2900,
                },
                "viability_line_low":  1000,
                "viability_line_high": 2900,
                "chart_label":  "Growing Degree Days",
                "description":  "Heat accumulation Apr–Oct above 10°C. Too little = grapes won't ripen. Too much = low-quality fruit.",
                "source":       "Winkler & Amerine (1974) — Winkler Index",
            },
            "navel_orange_frost_days": {
                "label":        "Navel Orange Frost Risk Days",
                "category":     "crop",
                "units":        "days",
                "direction":    "lower_is_better",
                "thresholds": {
                    "green_max":  0,
                    "amber_max":  2,
                    "red_min":    3,
                },
                "viability_line": 2,
                "chart_label":  "Frost Days (days)",
                "description":  "Days where Tmin < -2.2°C (28°F). Even brief frosts damage citrus fruit.",
                "source":       "California Citrus Mutual",
            },
            "avocado_hard_freeze_days": {
                "label":        "Avocado Hard Freeze Days",
                "category":     "crop",
                "units":        "days",
                "direction":    "lower_is_better",
                "thresholds": {
                    "green_max":  0,
                    "amber_max":  1,
                    "red_min":    2,
                },
                "viability_line": 1,
                "chart_label":  "Hard Freeze Days (days)",
                "description":  "Days where Tmin < -1.1°C (30°F). Hard freezes can kill avocado trees outright.",
                "source":       "California Avocado Growers",
            },
            "navel_orangeworm_dd": {
                "label":        "Navel Orangeworm Degree Days",
                "category":     "pest",
                "units":        "GDD",
                "direction":    "lower_is_better",
                "pressure_direction": "higher_is_worse",
                "thresholds": {
                    "green_max":  600,
                    "amber_max":  800,
                    "red_min":    800,
                },
                "viability_line": 800,
                "chart_label":  "Degree Days",
                "description":  "Heat accumulation Mar–Oct above 12.8°C (55°F). More degree days = more pest generations per season.",
                "source":       "UC IPM Guidelines",
            },
            "vine_mealybug_development_days": {
                "label":        "Vine Mealybug Winter Development Days",
                "category":     "pest",
                "units":        "days",
                "direction":    "lower_is_better",
                "pressure_direction": "higher_is_worse",
                "thresholds": {
                    "green_max":  10,
                    "amber_max":  20,
                    "red_min":    20,
                },
                "viability_line": 20,
                "chart_label":  "Development Days (days)",
                "description":  "Winter days (Nov–Feb) where Tmin > 11°C. Warmer winters allow year-round mealybug development.",
                "source":       "Gutierrez et al. (2008) J. Applied Ecology",
            },
            "spotted_wing_drosophila_mortality": {
                "label":        "Spotted Wing Drosophila Mortality Days",
                "category":     "pest",
                "units":        "days",
                "direction":    "higher_is_better",
                "pressure_direction": "lower_is_worse",
                "thresholds": {
                    "green_min":  5,
                    "amber_min":  2,
                    "red_max":    2,
                },
                "viability_line": 5,
                "chart_label":  "Mortality Days (days)",
                "description":  "Days where Tmin < -5°C. Cold winters limit SWD range. Fewer cold days = wider infestation risk.",
                "source":       "Asplen et al. (2015) J. Pest Science",
            },
        },
    }

    out_path = PNG_DIR / "metadata.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(metadata, f, indent=2)

    size_kb = out_path.stat().st_size / 1024
    print(f"  Saved metadata.json ({size_kb:.1f} KB)")
    return metadata

# ---------------------------------------------------------------------------
# Check mode
# ---------------------------------------------------------------------------

def run_check():
    """Verify all expected PNGs exist."""
    print(f"\n{'='*62}")
    print(f"  PNG completeness check")
    print(f"{'='*62}\n")

    total_expected = 0
    total_found    = 0
    all_ok         = True

    for metric_name in COLOR_FUNCTIONS:
        out_dir  = PNG_DIR / metric_name
        expected = len(HIST_YEARS) + len(FUTURE_YEARS) * len(SCENARIOS)
        found    = len(list(out_dir.glob("*.png"))) if out_dir.exists() else 0
        ok       = found == expected
        if not ok:
            all_ok = False
        total_expected += expected
        total_found    += found
        status = "OK" if ok else f"INCOMPLETE ({found}/{expected})"
        print(f"  {metric_name:<45} {status}")

    print(f"\n  Total: {total_found}/{total_expected} PNGs")
    if all_ok:
        print(f"  All PNGs present. Ready for frontend.")
    else:
        missing = total_expected - total_found
        print(f"  {missing} PNGs missing. Run tile_pngs.py to generate.")

    # Check metadata
    meta_path = PNG_DIR / "metadata.json"
    print(f"\n  metadata.json: {'EXISTS' if meta_path.exists() else 'MISSING'}")
    print()

# ---------------------------------------------------------------------------
# Dry run
# ---------------------------------------------------------------------------

def run_dry_run():
    """Print what would be generated without doing it."""
    print(f"\n  Dry run — files that would be generated:\n")
    total = 0
    for metric_name in COLOR_FUNCTIONS:
        count = len(HIST_YEARS) + len(FUTURE_YEARS) * len(SCENARIOS)
        print(f"  pngs/{metric_name}/  →  {count} PNGs")
        total += count
    print(f"\n  Total: {total} PNGs + 1 metadata.json")
    print(f"  Estimated size: ~{total * 25 / 1024:.0f} MB (rough estimate at ~25KB/PNG)")
    print()

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Remnant Biome - PNG tiling pipeline"
    )
    parser.add_argument(
        "--metric",
        help="Tile one specific metric only (by name)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check which PNGs exist without generating anything",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be generated without doing it",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Regenerate PNGs even if they already exist",
    )
    parser.add_argument(
        "--metadata-only",
        action="store_true",
        help="Only regenerate metadata.json, skip PNGs",
    )
    args = parser.parse_args()

    if args.check:
        run_check()
        return

    if args.dry_run:
        run_dry_run()
        return

    if args.metadata_only:
        print("\nGenerating metadata.json...")
        generate_metadata()
        return

    # Generate metadata first
    print(f"\n{'='*62}")
    print(f"  Remnant Biome - PNG Tiling Pipeline")
    print(f"{'='*62}")
    print(f"\nGenerating metadata.json...")
    generate_metadata()

    # Tile metrics
    metrics_to_run = (
        [args.metric] if args.metric
        else list(COLOR_FUNCTIONS.keys())
    )

    print(f"\nTiling {len(metrics_to_run)} metric(s)...\n")

    for metric_name in metrics_to_run:
        tile_metric(metric_name, force=args.force)

    print(f"\n{'='*62}")
    print(f"  PNG tiling complete.")
    print(f"  Run: python tile_pngs.py --check to verify")
    print(f"{'='*62}\n")


if __name__ == "__main__":
    main()
