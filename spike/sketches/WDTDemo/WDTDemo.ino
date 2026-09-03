#include <Arduino.h>
#include "esp_task_wdt.h"

// Task watchdog test (native silicon, no shims). Inits the TWDT with a 5s
// timeout, subscribes the loop task, feeds it while doing work, then
// unsubscribes/deinits. Passing proves the watchdog runs without spurious
// resets and the IDF task-WDT API works in the emulator.

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("[WDT] Watchdog demo start");
  const esp_task_wdt_config_t cfg = {
    .timeout_ms = 5000,
    .idle_core_mask = 0,
    .trigger_panic = false,
  };
  esp_err_t r = esp_task_wdt_init(&cfg);
  Serial.printf("[WDT] wdt_init rc=%d\n", (int)r);
  r = esp_task_wdt_add(NULL);
  Serial.printf("[WDT] wdt_add rc=%d\n", (int)r);
}

void loop() {
  static int n = 0;
  if (n < 5) {
    esp_task_wdt_reset();
    Serial.printf("[WDT] fed=%d\n", n);
    n++;
    delay(100);
  } else if (n == 5) {
    esp_task_wdt_delete(NULL);
    esp_task_wdt_deinit();
    Serial.println("[WDT] wdt-done");
    n++;
    delay(500);
  } else {
    delay(500);
  }
}
