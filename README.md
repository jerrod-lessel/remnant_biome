# Remnant Biome

**A free, interactive climate literacy tool showing how California's agricultural and pest climate envelopes shift from 1980 to 2100.**

Built for [LesselGeospatial.com](https://lesselgeospatial.com) - *someone has to map this mess.*

---

## What it does

Remnant Biome lets you watch California's farming viability zones move in real time across four emissions scenarios. Click anywhere on the map, get a plain-language explanation of what the climate is doing to the crops and pests at that location, and see exactly when things start to go sideways.

It's designed for people who don't already know what a chill hour is. By the end of a five-minute session, they will.

---

## Crops and pests modeled

| Subject | Metric | Threshold | Source |
|---|---|---|---|
| Almonds | Chill hours (Nov–Feb) | 400 hrs/season minimum | UC ANR / AgNote — Nonpareil variety |
| Wine grapes | Chill hours (Nov–Feb) | 150 hrs/season minimum | Luedeling et al. (2009) |
| Wine grapes | Growing degree days (Apr–Oct, base 10°C) | 1000–2900 GDD viable range | Winkler & Amerine (1974) |
| Navel oranges | Frost risk days (Tmin < -2.2°C / 28°F) | 0 days | California Citrus Mutual |
| Avocados | Hard freeze days (Tmin < -1.1°C / 30°F) | 0 days | California Avocado Growers |
| Navel orangeworm | Degree day accumulation (base 12.8°C / 55°F, Mar–Oct) | < 800 DD = low pressure | UC IPM Guidelines |
| Vine mealybug | Winter development days (Tmin > 11°C, Nov–Feb) | 0 days = no overwinter development | Gutierrez et al. (2008) |
| Spotted wing drosophila | Mortality days (Tmin < -5°C / 23°F) | > 5 days = range limited | Asplen et al. (2015) |

---

## Data sources

**LOCA2-Hybrid CA** - primary climate data source
- Statistically downscaled CMIP6 at ~3km resolution
- Daily Tmax and Tmin, 1950-2100
- 3 models: EC-Earth3, MIROC6, MRI-ESM2-0 (r1i1p1f1)
- 3 scenarios: SSP2-4.5, SSP3-7.0, SSP5-8.5
- Used by California's 5th Climate Assessment
- Source: [Cal-Adapt S3](https://analytics.cal-adapt.org/data/access/)

**Scenarios displayed:**
| SSP code | Plain-language label |
|---|---|
| SSP2-4.5 | current policy |
| SSP3-7.0 | high emissions |
| SSP5-8.5 | worst case |

---

## Architecture

No backend. No server. Just a pipeline that runs once on your machine and a static site that serves the results forever.

```
Raw LOCA2 (~153GB)         lives on your machine, never deployed
      ↓
Python pipeline            compute metrics per grid cell per year
      ↓
Zarr stores (~700MB)       intermediate processed data
      ↓
PNG stack (~300MB)         one image per metric × year × scenario
      ↓
Cloudflare Pages           serves PNGs + metadata JSON to MapLibre
```

**Stack:**
- Pipeline: Python, xarray, zarr, numpy
- Frontend: MapLibre GL JS, Cloudflare Pages
- Data: LOCA2-Hybrid CA (Cal-Adapt S3)

---

## Pipeline

### Setup

```bash
git clone https://github.com/jerrod-lessel/remnant_biome.git
cd remnant_biome
python -m venv .venv
source .venv/bin/activate
pip install boto3 botocore xarray netcdf4 zarr pyyaml numpy dask
```

### Download raw data

```bash
# See all 60 files with index numbers
python download_loca2.py --manifest

# Download one file at a time (recommended — ~3GB each)
python download_loca2.py --file 1
```

### Compute metrics

```bash
# Run one model/scenario job
python compute_metrics.py --model EC-Earth3 --scenario historical

# Delete raw files after computing to recover disk space
python compute_metrics.py --model EC-Earth3 --scenario ssp245 --delete-raw
```

### Adding new metrics

All metrics are defined in `metrics.yaml`. Adding a new crop or pest requires zero pipeline code changes — just add a new block to the yaml:

```yaml
my_new_crop_metric:
  label: "My New Crop"
  type: threshold_days        # or chill_hours, degree_days
  variable: tasmin
  threshold_c: -1.0
  operator: below
  months: all
  season_label: annual
  viability_max: 3
  output_units: days
  category: crop
```

---

## Methodology notes

Chill hours are estimated using a daily min/max linear proxy method following Luedeling et al. (2009). The Dynamic Model may be more appropriate for quantitative planning applications — this tool is designed for climate literacy, not precision agricultural forecasting.

Ensemble spread (p10/p90) is computed across three CMIP6 models using one realization per model (r1i1p1f1), following standard multi-model ensemble practice.

---

## Status

- [x] Data pipeline - download, compute, zarr output
- [x] Ensemble aggregation (median, p10, p90)
- [x] PNG tiling
- [ ] MapLibre frontend
- [ ] Cloudflare Pages deployment

---

## References

- Luedeling et al. (2009). Climate change effects on walnut and almond production in California. *PLOS ONE.*
- Winkler et al. (1974). *General Viticulture.* UC Press.
- Snyder & Melo-Abreu (2005). *Frost Protection.* FAO.
- Whiley et al. (2002). *The Avocado: Botany, Production and Uses.* CABI.
- Morse et al. (1995). UC IPM Pest Management Guidelines: Navel Orangeworm.
- Daane et al. (2006). Vine mealybug: a new pest in California vineyards. *California Agriculture.*
- Dalton et al. (2011). Ecology and management of spotted wing drosophila. *Journal of Integrated Pest Management.*

---

*Part of the [LesselGeospatial](https://lesselgeospatial.com) portfolio - geospatial tools built with too much caffeine and just enough hubris.*
