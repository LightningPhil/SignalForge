# Evidence-qualified support matrix

This is a compact human-readable view of `support_matrix.json`. The JSON file is authoritative and should feed tests or documentation generation.

| Brand | Verified with vendor/hardware fixture | Synthetic or experimental | Explicitly outside the present claim |
|---|---|---|---|
| Tektronix | WFM#003 LE analogue; single frame and FastFrame | ISF signed int16 BE | WFM#001/#002/BE, digital, IQ, histogram |
| PicoScope | PSDATA recognition/conversion route only | CSV layout-tested; HDF5 experimental | Native PSDATA decode |
| Keysight/Agilent | AG10 ordinary analogue, DSO-X 1102G | AG01 and AG03 ordinary analogue layouts | segmented, peak detect, logic/digital |
| Rohde & Schwarz | RTx float32, int8 and XYDOUBLEFLOAT analogue | int16 layout | history/multi-acquisition, digital, buses, maths/spectrum/track |
| Teledyne LeCroy | LECROY_1_0 and 2_3 LE int16 single sweep | LECROY_2_3 BE int16 | sequences/subarrays, secondary arrays, peak-detect pairs |
| Rigol | DS1000B/C/D-E/Z, DS2000, DS4000 WFM; MSO5000 BIN; DHO800 WFM/BIN | none | DS6000 and MSO7000/8000 remain provisional without real fixtures |

Counts in the current bundle:

- Six manufacturers.
- Twenty-five directly decoded primary fixtures.
- Four R&S companion payload fixtures.
- One conversion-required PSDATA fixture.
- Nine distinct fixture-proven Rigol parser paths.
- Both real-file and synthetic edge-case evidence, labelled separately.
