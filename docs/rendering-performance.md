# Rendering performance

Run `npm run benchmark:render` from a checkout with dependencies installed. Electron needs a graphical display.

The benchmark runs the production WebGL renderer with a parent and 0, 6, or 8 working agents. It reports CPU time per frame after warmup, uploaded bytes, GPU buffer allocations, and paints delivered for 60 simulated display callbacks. GPU completion is outside the CPU timer; these timings are not measured display FPS.

On the development Mac with Electron 44.9.0, the eight-agent scene changed from:

| Measurement                            | Before |  After |
| -------------------------------------- | -----: | -----: |
| Median CPU time per paint              | 5.1 ms | 0.6 ms |
| 95th percentile CPU time               | 5.7 ms | 0.8 ms |
| GPU buffer allocations over 180 paints |    360 |      0 |
| Paints per 60 callbacks                |     20 |     60 |

A separate three-second run in a visible Electron window rendered the eight-agent scene at about 60 FPS, with a 17.6 ms 95th-percentile frame interval.

The renderer now follows the display cadence instead of using a 30 Hz elapsed-time gate. It retains typed vertex storage and GPU capacity, uploads only live vertices, caches ring coordinates, and computes body rotations once per transform. Hidden scenes and Motion off still suspend animation.

Regression coverage checks 60/120 Hz cadence, storage reuse, unchanged static buffers, clipping, body transforms, robot lifecycles, and all shipped themes in Electron.
