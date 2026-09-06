// Raw ESP-IDF USB-Serial/JTAG driver test (NO Arduino USB CDC): install,
// write a greeting, read a short host reply with timeout, echo it back.
// The loader's usb_serial_jtag shims route bytes to/from the UART console
// (write = raw console text, read = RX FIFO poll), so no WASM USB glue is
// needed. Kept separate from other sketches: the driver owns the USJ port.
#include <Arduino.h>
#include "driver/usb_serial_jtag.h"

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("[USBJTAG] USB Serial/JTAG demo start");

  usb_serial_jtag_driver_config_t cfg = {
    .tx_buffer_size = 256,
    .rx_buffer_size = 256,
  };
  esp_err_t r0 = usb_serial_jtag_driver_install(&cfg);
  Serial.printf("[USBJTAG] install rc=%d connected=%d\n",
                (int)r0, (int)usb_serial_jtag_is_connected());

  const char *hello = "usb-jtag-hello\n";
  int n = usb_serial_jtag_write_bytes(hello, strlen(hello), 50);
  Serial.printf("[USBJTAG] wrote %d\n", n);

  uint8_t buf[8] = {0};
  int m = usb_serial_jtag_read_bytes(buf, 3, 50);
  Serial.printf("[USBJTAG] read %d got=%02X%02X%02X\n", m, buf[0], buf[1], buf[2]);
  bool ok = (r0 == ESP_OK) && (n == 15) && (m == 3) &&
            buf[0] == 0xDE && buf[1] == 0xAD && buf[2] == 0xBE;
  if (ok) Serial.println("[USBJTAG] usb-jtag-done");
  else Serial.println("[USBJTAG] usb-jtag-FAILED");
}

void loop() {
  delay(500);
}
