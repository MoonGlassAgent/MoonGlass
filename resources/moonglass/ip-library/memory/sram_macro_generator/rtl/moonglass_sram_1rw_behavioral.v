module moonglass_sram_1rw_behavioral #(
    parameter DEPTH = 288,
    parameter DATA_WIDTH = 80,
    parameter ADDR_WIDTH = 9
) (
    input                       CLK,
    input                       CEN,
    input      [ADDR_WIDTH-1:0] A,
    input      [DATA_WIDTH-1:0] D,
    input                       WEN,
    output reg [DATA_WIDTH-1:0] Q
);

reg [DATA_WIDTH-1:0] mem [0:DEPTH-1];

always @(posedge CLK) begin
    if (!CEN) begin
        if (!WEN) begin
            if (A < DEPTH)
                mem[A] <= D;
            else
                $display("WARNING: SRAM write address %0d is outside depth %0d", A, DEPTH);
        end else begin
            if (A < DEPTH)
                Q <= mem[A];
            else begin
                Q <= {DATA_WIDTH{1'bx}};
                $display("WARNING: SRAM read address %0d is outside depth %0d", A, DEPTH);
            end
        end
    end
end

endmodule

