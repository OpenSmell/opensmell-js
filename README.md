# opensmell

The OpenSmell JS SDK — digital olfaction for Node.js and the browser. A 1:1
TypeScript port of the reference Python SDK (`opensmell` on PyPI) and the Rust
SDK (`opensmell` on crates.io).

## Install

```sh
npm install opensmell
```

Requires Node 18+ (or any modern browser bundler). ESM only.

## What's inside

- **`.osmell` I/O** — read/write the OpenSmell bundle format (ZIP: `manifest.json`
  + `data.csv` + optional `events.json`), MIME `application/vnd.opensmell.osmell`.
- **CSV ingestion** — tolerant parser: delimiter sniffing, quote-aware rows,
  time-column detection (ms, epoch seconds, ISO datetime, `HH:MM:SS`), synthetic
  10 Hz timing fallback, context-column preservation, non-finite/unsorted handling.
- **Normalization** — Rs/R0 normalization, explicit/auto baseline windows, the
  SmellNet-style MOX feature framework (per-channel device-agnostic, absolute,
  temporal, health, hardware, decay, saturation + selectivity + global features;
  `28·c + c(c−1)/2 + 4`).
- **Quality scoring** — the spec-compliant 7-factor MOX scorer (continuity,
  dynamic range, saturation-free, baseline stability, signal strength, recovery,
  duration adequacy) with sensor-family dispatch.
- **Ingest** — folder-of-CSVs → labeled, scored collections (sub-folder =
  substance), adopt-don't-reject.
- **Hardware gate** — §10.10 N→M effective-dimensionality sufficiency check
  (Warn-and-Proceed).

## Quick start

```ts
import {
  parseOsmellFile,
  computeQuality,
  runProcessor,
  buildOsmellFile,
  ingestFile,
  featureNames,
} from "opensmell";

// Parse a recording bundle and score it.
const file = await parseOsmellFile("exposure.osmell");
const report = computeQuality(file, file.time.length, file.manifest.sensor.samplingRateHz ?? 10);
console.log(report.total, report.badge); // 90 "Excellent"

// Or ingest a plain CSV from disk — never rejects on structure.
const session = await ingestFile("coffee/session_1.csv", "coffee");
if (session.ok) {
  console.log(session.sensorType, session.report?.badge, session.warnings);
}

// MOX kinetic features + the canonical framework feature vector.
const features = runProcessor(file);
console.log(features.sensor_type, featureNames().length); // "mox" 187
```

## API

```
io:            parseOsmell, parseOsmellFile, buildOsmell, writeOsmell,
               csvFromFile, defaultFileName, OSMELL_MIME_TYPE
csv:           parseCsv, guessSensorType, detectTimeColumn, safeFloat,
               isContextColumn, MOX_CHANNEL_IDS
normalize:     median, mean, std, r0FromSamples, baselineForChannel,
               normalizedSeries, channelStats
quality:       computeQuality, computeQualityMox, WEIGHTS
features:      processMox, runProcessor, extractAllFrameworkFeatures,
               featureNames, frameworkFeatureLen, computeChannel*,
               computeMultiExpDecay, computeSaturationIndex
ingest:        ingestFile, ingestFolder, buildOsmellFile,
               IngestedSession, IngestedCollection
hardware:      checkRigSufficiency, effectiveDims, effectiveRank,
               impliedChannels, minEffectiveDimensions
preprocessing: loadCsv, rsR0Normalize, segment, expandChannels
types:         OsmellFile, OsmellManifest, SensorDescriptor, ChannelDescriptor,
               SessionDescriptor, BaselineDescriptor, SessionEvent,
               ParsedSample, ChannelStats, QualityReport, QualityFlags,
               SubScore, OSMELL_FORMAT_VERSION, and manifest/session/event
               JSON converters
```

## Format

`.osmell` bundles are ZIP archives:
```
manifest.json   format version, sensor family/channels/ADC, session role,
                baseline, calibration, software, ingest provenance
data.csv        time column + one ADC column per sensor channel
events.json     optional labeled session events (startMs/endMs/note)
```

## License

MIT © 2026 OpenSmell Project. See [LICENSE](./LICENSE).