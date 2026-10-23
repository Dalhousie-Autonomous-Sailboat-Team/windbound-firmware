# Boat model for the 3D view

Mission control draws a default boat from `params/windbound.toml`. To show the real
Windbound instead, put a binary glTF file here as `boat.glb`, or pass
`--model path/to/boat.glb` to `serve`. The default comes back whenever
the file is missing.

## What the file needs

- **Units:** metres. Mission control warns when the model's length looks wrong.
- **Axes** (glTF's own): +Y up, the bow toward +Z, starboard toward -X. The
  origin is on the centreline at the waterline, below the centre of gravity.
  In Blender that means Z up, the bow toward -Y, starboard toward -X; the glTF
  exporter converts the axes for you.
- **Moving parts as their own objects, named:**
  - `wing` (or anything containing `sail` or `mast`): its origin on the mast's
    pivot axis.
  - `rudder`: its origin on the rudder stock.
  - `vane` (optional): the masthead windvane, origin on its pin.

  Each part turns about its own vertical axis, so put the origin on that axis.
  In Blender: place the 3D cursor on the axis, then Object > Set Origin >
  Origin to 3D Cursor. A model without these parts still shows, but nothing on
  it moves, and Mission control says so under the 3D view.

## From CAD (best)

If the mechanical team has a CAD model, export it as STEP or OBJ, import it
into Blender (free), join the parts into hull, wing and rudder objects, set
the origins as above, and use File > Export > glTF 2.0 with the format set to
glTF Binary (.glb).

## From photos

Photogrammetry turns 60-150 photos of the boat into a mesh:

1. Put the boat on its stand out of the water, in even, overcast light.
2. Walk around it taking overlapping photos at two or three heights, then
   from above. Matte surfaces work best; shiny ones confuse the reconstruction.
3. Build the mesh with a photogrammetry app (Polycam or Reality Composer on a
   phone, or Meshroom on a desktop) and export OBJ or glTF.
4. In Blender: scale it so the hull length matches a tape measurement,
   separate the wing and the rudder into their own objects (select their faces,
   then P > Selection), name them, set their origins on their pivot axes,
   reduce it to under about 200,000 triangles (Decimate modifier), and export
   glTF Binary (.glb) as above.

Run `python -m windbound_sim serve --scenario beam-reach` and check that the wing and
rudder turn the right way: positive sail swings the wing's trailing edge to
port, positive rudder turns the boat to starboard.
