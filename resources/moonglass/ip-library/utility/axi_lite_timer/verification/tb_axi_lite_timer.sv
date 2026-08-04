`timescale 1ns/1ps

module tb_axi_lite_timer;
  localparam [5:0] REG_CTRL     = 6'h00;
  localparam [5:0] REG_PRESCALE = 6'h04;
  localparam [5:0] REG_LOAD     = 6'h08;
  localparam [5:0] REG_VALUE    = 6'h0c;
  localparam [5:0] REG_STATUS   = 6'h10;

  reg         aclk;
  reg         aresetn;
  reg  [5:0]  s_axi_awaddr;
  reg         s_axi_awvalid;
  wire        s_axi_awready;
  reg  [31:0] s_axi_wdata;
  reg  [3:0]  s_axi_wstrb;
  reg         s_axi_wvalid;
  wire        s_axi_wready;
  wire [1:0]  s_axi_bresp;
  wire        s_axi_bvalid;
  reg         s_axi_bready;
  reg  [5:0]  s_axi_araddr;
  reg         s_axi_arvalid;
  wire        s_axi_arready;
  wire [31:0] s_axi_rdata;
  wire [1:0]  s_axi_rresp;
  wire        s_axi_rvalid;
  reg         s_axi_rready;
  wire        timer_irq;

  reg [31:0] read_data;

  axi_lite_timer dut (
    .aclk(aclk),
    .aresetn(aresetn),
    .s_axi_awaddr(s_axi_awaddr),
    .s_axi_awvalid(s_axi_awvalid),
    .s_axi_awready(s_axi_awready),
    .s_axi_wdata(s_axi_wdata),
    .s_axi_wstrb(s_axi_wstrb),
    .s_axi_wvalid(s_axi_wvalid),
    .s_axi_wready(s_axi_wready),
    .s_axi_bresp(s_axi_bresp),
    .s_axi_bvalid(s_axi_bvalid),
    .s_axi_bready(s_axi_bready),
    .s_axi_araddr(s_axi_araddr),
    .s_axi_arvalid(s_axi_arvalid),
    .s_axi_arready(s_axi_arready),
    .s_axi_rdata(s_axi_rdata),
    .s_axi_rresp(s_axi_rresp),
    .s_axi_rvalid(s_axi_rvalid),
    .s_axi_rready(s_axi_rready),
    .timer_irq(timer_irq)
  );

  initial begin
    aclk = 1'b0;
    forever #5 aclk = ~aclk;
  end

  task axi_write;
    input [5:0] addr;
    input [31:0] data;
    begin
      @(posedge aclk);
      s_axi_awaddr <= addr;
      s_axi_wdata <= data;
      s_axi_wstrb <= 4'hf;
      s_axi_awvalid <= 1'b1;
      s_axi_wvalid <= 1'b1;
      s_axi_bready <= 1'b1;
      wait (s_axi_awready && s_axi_wready);
      @(posedge aclk);
      s_axi_awvalid <= 1'b0;
      s_axi_wvalid <= 1'b0;
      wait (s_axi_bvalid);
      if (s_axi_bresp !== 2'b00) begin
        $fatal(1, "AXI write response failed: addr=%0h resp=%0b", addr, s_axi_bresp);
      end
      @(posedge aclk);
      s_axi_bready <= 1'b0;
    end
  endtask

  task axi_read;
    input [5:0] addr;
    output [31:0] data;
    begin
      @(posedge aclk);
      s_axi_araddr <= addr;
      s_axi_arvalid <= 1'b1;
      s_axi_rready <= 1'b1;
      wait (s_axi_arready);
      @(posedge aclk);
      s_axi_arvalid <= 1'b0;
      wait (s_axi_rvalid);
      data = s_axi_rdata;
      if (s_axi_rresp !== 2'b00) begin
        $fatal(1, "AXI read response failed: addr=%0h resp=%0b", addr, s_axi_rresp);
      end
      @(posedge aclk);
      s_axi_rready <= 1'b0;
    end
  endtask

  task wait_irq;
    input integer max_cycles;
    integer cycle;
    begin
      cycle = 0;
      while (!timer_irq && cycle < max_cycles) begin
        @(posedge aclk);
        cycle = cycle + 1;
      end
      if (!timer_irq) begin
        $fatal(1, "timer_irq timeout after %0d cycles", max_cycles);
      end
    end
  endtask

  initial begin
    $dumpfile("axi_lite_timer.vcd");
    $dumpvars(0, tb_axi_lite_timer);

    aresetn = 1'b0;
    s_axi_awaddr = 6'd0;
    s_axi_awvalid = 1'b0;
    s_axi_wdata = 32'd0;
    s_axi_wstrb = 4'd0;
    s_axi_wvalid = 1'b0;
    s_axi_bready = 1'b0;
    s_axi_araddr = 6'd0;
    s_axi_arvalid = 1'b0;
    s_axi_rready = 1'b0;

    repeat (4) @(posedge aclk);
    aresetn = 1'b1;
    repeat (2) @(posedge aclk);

    axi_write(REG_PRESCALE, 32'd0);
    axi_write(REG_LOAD, 32'd5);
    axi_write(REG_CTRL, 32'h0000_0005);
    wait_irq(20);

    axi_read(REG_STATUS, read_data);
    if (read_data[0] !== 1'b1) begin
      $fatal(1, "expired status bit was not set");
    end

    axi_read(REG_VALUE, read_data);
    if (read_data !== 32'd0) begin
      $fatal(1, "timer value should stop at zero, got %0d", read_data);
    end

    axi_write(REG_STATUS, 32'd1);
    repeat (2) @(posedge aclk);
    if (timer_irq !== 1'b0) begin
      $fatal(1, "timer_irq did not clear after STATUS W1C");
    end

    axi_write(REG_LOAD, 32'd3);
    axi_write(REG_CTRL, 32'h0000_0007);
    wait_irq(20);
    axi_write(REG_STATUS, 32'd1);
    repeat (1) @(posedge aclk);
    wait_irq(20);

    axi_write(REG_CTRL, 32'd0);
    axi_write(REG_STATUS, 32'd1);
    repeat (2) @(posedge aclk);
    if (timer_irq !== 1'b0) begin
      $fatal(1, "timer_irq should stay low after stop and clear");
    end

    $display("SMOKE_PASS axi_lite_timer");
    $finish;
  end
endmodule
