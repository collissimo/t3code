// WindowFromPoint takes its POINT by value, which on x64 travels as one 64-bit integer.

type WindowAtPoint = (x: number, y: number) => bigint;

let windowAtPoint: Promise<WindowAtPoint> | undefined;

export function loadWindowAtPoint(): Promise<WindowAtPoint> {
  windowAtPoint ??= import("ffi-rs").then(({ DataType, load, open }) => {
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
  });
  return windowAtPoint;
}
