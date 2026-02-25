#define MICROPY_HW_BOARD_NAME "Guition ESP32-S3-4848S040"
#define MICROPY_HW_MCU_NAME   "ESP32-S3"

// Enable UART REPL — this board has an external CH340 USB-UART on UART0,
// not native USB. Same approach as ESP32_GENERIC_S3.
#define MICROPY_HW_ENABLE_UART_REPL (1)
