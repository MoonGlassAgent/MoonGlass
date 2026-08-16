#!/usr/bin/env python3
"""Generate fixed-size 1RW SRAM simulation, blackbox and wrapper views."""

from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path


IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")
SIZE_IN_NAME = re.compile(r"(\d+)[xX](\d+)")


def identifier(value: str) -> str:
    if not IDENTIFIER.fullmatch(value):
        raise argparse.ArgumentTypeError(f"非法 Verilog 标识符: {value}")
    return value


def positive(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("尺寸必须大于 0")
    return number


def infer_size(name: str) -> tuple[int | None, int | None]:
    match = SIZE_IN_NAME.search(name)
    return (int(match.group(1)), int(match.group(2))) if match else (None, None)


def macro_ports(module_name: str, depth: int, width: int, addr_width: int, behavioral: bool) -> str:
    output = "output reg" if behavioral else "output"
    body = f"""module {module_name} (
    CLK, CEN, A, D, WEN, RETIN, EMA, EMAW, EMAS,
    WABL, WABLM, RAWL, RAWLM, Q
);

input CLK;
input CEN;
input [{addr_width - 1}:0] A;
input [{width - 1}:0] D;
input WEN;
input RETIN;
input [2:0] EMA;
input [1:0] EMAW;
input EMAS;
input WABL;
input [1:0] WABLM;
input RAWL;
input [1:0] RAWLM;
{output} [{width - 1}:0] Q;
"""
    if not behavioral:
        return f"(* blackbox *)\n{body}\nendmodule\n"
    return body + f"""
reg [{width - 1}:0] mem [0:{depth - 1}];

always @(posedge CLK) begin
    if (!CEN) begin
        if (!WEN) begin
            if (A < {depth})
                mem[A] <= D;
            else
                $display("WARNING: {module_name} write address %0d is outside depth {depth}", A);
        end else begin
            if (A < {depth})
                Q <= mem[A];
            else begin
                Q <= {{{width}{{1'bx}}}};
                $display("WARNING: {module_name} read address %0d is outside depth {depth}", A);
            end
        end
    end
end

// RETIN/EMA/EMAW/EMAS/WABL/WABLM/RAWL/RAWLM are timing-assist pins.
// The generic functional model accepts them but does not model PVT behavior.
endmodule
"""


def wrapper(module_name: str, macro_name: str, depth: int, width: int, addr_width: int) -> str:
    return f"""module {module_name} (
    clk, ce, we, addr, data_in, data_out
);

localparam ADDR_WIDTH = {addr_width};
localparam DATA_WIDTH = {width};
localparam DEPTH = {depth};

input clk;
input ce;
input we;
input [ADDR_WIDTH-1:0] addr;
input [DATA_WIDTH-1:0] data_in;
output [DATA_WIDTH-1:0] data_out;

wire we_n = ~we;
wire ce_n = ~ce;

{macro_name} U_{macro_name} (
    .CLK(clk), .CEN(ce_n), .A(addr), .D(data_in), .WEN(we_n),
    .RETIN(1'b1), .EMA(3'b010), .EMAW(2'b00), .EMAS(1'b0),
    .WABL(1'b1), .WABLM(2'b00), .RAWL(1'b0), .RAWLM(2'b00),
    .Q(data_out)
);

endmodule
"""


def main() -> None:
    parser = argparse.ArgumentParser(description="生成固定尺寸 SRAM 宏的三类逻辑视图")
    parser.add_argument("--macro-name", required=True, type=identifier)
    parser.add_argument("--wrapper-name", type=identifier)
    parser.add_argument("--depth", type=positive)
    parser.add_argument("--width", type=positive)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()

    inferred_depth, inferred_width = infer_size(args.macro_name)
    depth = args.depth or inferred_depth
    width = args.width or inferred_width
    if not depth or not width:
        parser.error("无法从宏名称推断尺寸，请同时提供 --depth 和 --width")
    if inferred_depth and args.depth and inferred_depth != args.depth:
        parser.error(f"宏名称深度 {inferred_depth} 与 --depth {args.depth} 不一致")
    if inferred_width and args.width and inferred_width != args.width:
        parser.error(f"宏名称位宽 {inferred_width} 与 --width {args.width} 不一致")

    addr_width = max(1, math.ceil(math.log2(depth)))
    wrapper_name = args.wrapper_name or f"SRAMS{depth}X{width}"
    args.output_dir.mkdir(parents=True, exist_ok=True)
    files = {
        "behavioral": args.output_dir / f"{args.macro_name}_behavioral.v",
        "blackbox": args.output_dir / f"{args.macro_name}_blackbox.v",
        "wrapper": args.output_dir / f"{wrapper_name}.v",
        "manifest": args.output_dir / f"{args.macro_name}.json",
    }
    files["behavioral"].write_text(macro_ports(args.macro_name, depth, width, addr_width, True), encoding="ascii")
    files["blackbox"].write_text(macro_ports(args.macro_name, depth, width, addr_width, False), encoding="ascii")
    files["wrapper"].write_text(wrapper(wrapper_name, args.macro_name, depth, width, addr_width), encoding="ascii")
    manifest = {
        "schemaVersion": 1,
        "macroName": args.macro_name,
        "wrapperName": wrapper_name,
        "kind": "sram-1rw",
        "depth": depth,
        "width": width,
        "addressWidth": addr_width,
        "clockEdge": "rising",
        "controls": {"CEN": "active-low", "WEN": "active-low"},
        "readLatency": 1,
        "writeLatency": 1,
        "invalidAddress": "read-x-write-ignore",
        "views": {name: path.name for name, path in files.items() if name != "manifest"},
        "missingSignoffViews": ["liberty", "lef", "gds"],
        "notice": "Generic functional model only. Do not use for SRAM timing, area or power signoff.",
    }
    files["manifest"].write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "files": {name: str(path) for name, path in files.items()}, "manifest": manifest}, ensure_ascii=False))


if __name__ == "__main__":
    main()

