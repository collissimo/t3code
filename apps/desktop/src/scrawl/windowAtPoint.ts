// WindowFromPoint takes its POINT by value, which on x64 travels as one 64-bit integer.

export async function loadWindowAtPoint(): Promise<(x: number, y: number) => bigint> {
  const { DataType, load, open } = await import("ffi-rs");
  const library = "scrawl-point-user32";
  open({ library, path: "user32.dll" });
  return (x, y) =>
    load({
      library,
      funcName: "WindowFromPoint",
      retType: DataType.BigInt,
      paramsType: [DataType.BigInt],
      paramsValue: [(BigInt(Math.round(y)) << 32n) | (BigInt(Math.round(x)) & 0xffff_ffffn)],
    }) as bigint;
}
