// AXI-Lite single-shot / auto-reload timer.
module axi_lite_timer (
  input  wire        aclk,
  input  wire        aresetn,

  input  wire [5:0]  s_axi_awaddr,
  input  wire        s_axi_awvalid,
  output wire        s_axi_awready,
  input  wire [31:0] s_axi_wdata,
  input  wire [3:0]  s_axi_wstrb,
  input  wire        s_axi_wvalid,
  output wire        s_axi_wready,
  output reg  [1:0]  s_axi_bresp,
  output reg         s_axi_bvalid,
  input  wire        s_axi_bready,

  input  wire [5:0]  s_axi_araddr,
  input  wire        s_axi_arvalid,
  output wire        s_axi_arready,
  output reg  [31:0] s_axi_rdata,
  output reg  [1:0]  s_axi_rresp,
  output reg         s_axi_rvalid,
  input  wire        s_axi_rready,

  output wire        timer_irq
);

  localparam [1:0] AXI_RESP_OKAY = 2'b00;

  localparam [5:0] REG_CTRL     = 6'h00;
  localparam [5:0] REG_PRESCALE = 6'h04;
  localparam [5:0] REG_LOAD     = 6'h08;
  localparam [5:0] REG_VALUE    = 6'h0c;
  localparam [5:0] REG_STATUS   = 6'h10;

  reg        enable_q;
  reg        auto_reload_q;
  reg        irq_enable_q;
  reg        expired_q;
  reg [31:0] prescale_q;
  reg [31:0] prescale_count_q;
  reg [31:0] load_value_q;
  reg [31:0] timer_value_q;

  wire write_fire = s_axi_awready && s_axi_wready;
  wire read_fire = s_axi_arready && s_axi_arvalid;
  wire timer_tick = enable_q && (prescale_count_q >= prescale_q);
  wire [31:0] ctrl_read = {29'd0, irq_enable_q, auto_reload_q, enable_q};
  wire [31:0] status_read = {31'd0, expired_q};
  wire [31:0] ctrl_write_data = apply_wstrb(ctrl_read, s_axi_wdata, s_axi_wstrb);
  wire [31:0] prescale_write_data = apply_wstrb(prescale_q, s_axi_wdata, s_axi_wstrb);
  wire [31:0] load_write_data = apply_wstrb(load_value_q, s_axi_wdata, s_axi_wstrb);

  // 复位释放指示（同步释放）：复位期间/释放后首拍为低，用于替代组合复位门控。
  // 时钟/复位信号不得参与组合逻辑（moonglass-no-clk-rst-in-comb），
  // AXI ready 以寄存后的释放标志限定，行为等价且消除复位期间的组合毛刺风险。
  reg reset_released_q;
  always @(posedge aclk or negedge aresetn) begin
    if (!aresetn) begin
      reset_released_q <= 1'b0;
    end else begin
      reset_released_q <= 1'b1;
    end
  end

  assign s_axi_awready = reset_released_q && !s_axi_bvalid && s_axi_awvalid && s_axi_wvalid;
  assign s_axi_wready = s_axi_awready;
  assign s_axi_arready = reset_released_q && !s_axi_rvalid;
  assign timer_irq = expired_q && irq_enable_q;

  function [31:0] apply_wstrb;
    input [31:0] current_value;
    input [31:0] write_data;
    input [3:0]  write_strobe;
    integer byte_index;
    begin
      apply_wstrb = current_value;
      for (byte_index = 0; byte_index < 4; byte_index = byte_index + 1) begin
        if (write_strobe[byte_index]) begin
          apply_wstrb[(byte_index * 8) +: 8] = write_data[(byte_index * 8) +: 8];
        end
      end
    end
  endfunction

  function [31:0] read_register;
    input [5:0] addr;
    begin
      case (addr)
        REG_CTRL:     read_register = ctrl_read;
        REG_PRESCALE: read_register = prescale_q;
        REG_LOAD:     read_register = load_value_q;
        REG_VALUE:    read_register = timer_value_q;
        REG_STATUS:   read_register = status_read;
        default:      read_register = 32'd0;
      endcase
    end
  endfunction

  always @(posedge aclk or negedge aresetn) begin
    if (!aresetn) begin
      enable_q <= 1'b0;
      auto_reload_q <= 1'b0;
      irq_enable_q <= 1'b0;
      expired_q <= 1'b0;
      prescale_q <= 32'd0;
      prescale_count_q <= 32'd0;
      load_value_q <= 32'd1000;
      timer_value_q <= 32'd0;
      s_axi_bresp <= AXI_RESP_OKAY;
      s_axi_bvalid <= 1'b0;
      s_axi_rdata <= 32'd0;
      s_axi_rresp <= AXI_RESP_OKAY;
      s_axi_rvalid <= 1'b0;
    end else begin
      if (s_axi_bvalid && s_axi_bready) begin
        s_axi_bvalid <= 1'b0;
      end
      if (s_axi_rvalid && s_axi_rready) begin
        s_axi_rvalid <= 1'b0;
      end

      if (enable_q) begin
        if (timer_tick) begin
          prescale_count_q <= 32'd0;
          if (timer_value_q == 32'd0) begin
            expired_q <= 1'b1;
            if (auto_reload_q) begin
              timer_value_q <= load_value_q;
            end else begin
              enable_q <= 1'b0;
            end
          end else begin
            timer_value_q <= timer_value_q - 32'd1;
          end
        end else begin
          prescale_count_q <= prescale_count_q + 32'd1;
        end
      end else begin
        prescale_count_q <= 32'd0;
      end

      if (write_fire) begin
        s_axi_bresp <= AXI_RESP_OKAY;
        s_axi_bvalid <= 1'b1;
        case (s_axi_awaddr)
          REG_CTRL: begin
            {irq_enable_q, auto_reload_q, enable_q} <= ctrl_write_data[2:0];
            if (!enable_q && ctrl_write_data[0]) begin
              timer_value_q <= load_value_q;
              prescale_count_q <= 32'd0;
            end
          end
          REG_PRESCALE: begin
            prescale_q <= prescale_write_data;
            prescale_count_q <= 32'd0;
          end
          REG_LOAD: begin
            load_value_q <= load_write_data;
            timer_value_q <= load_write_data;
            prescale_count_q <= 32'd0;
          end
          REG_STATUS: begin
            if (s_axi_wstrb[0] && s_axi_wdata[0]) begin
              expired_q <= 1'b0;
            end
          end
          default: begin
          end
        endcase
      end

      if (read_fire) begin
        s_axi_rdata <= read_register(s_axi_araddr);
        s_axi_rresp <= AXI_RESP_OKAY;
        s_axi_rvalid <= 1'b1;
      end
    end
  end

endmodule
