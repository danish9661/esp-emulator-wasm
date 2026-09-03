#include <Arduino.h>
#include <sys/time.h>
#include "esp_timer.h"

// RTC / time test (native silicon, no shims). Verifies the microsecond
// esp_timer and wall-clock gettimeofday advance monotonically across delays
// and stay mutually consistent (within tolerance).

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("[RTC] RTC demo start");
}

void loop() {
  static int n = 0;
  static int64_t lastUs = 0;
  static int64_t lastTv = 0;
  if (n < 4) {
    int64_t us = esp_timer_get_time();
    struct timeval tv;
    gettimeofday(&tv, nullptr);
    int64_t tvUs = (int64_t)tv.tv_sec * 1000000LL + tv.tv_usec;
    bool mono = (n == 0) || (us > lastUs && tvUs > lastTv);
    int64_t skew = us > tvUs ? us - tvUs : tvUs - us;
    Serial.printf("[RTC] sample=%d esp_us=%lld tv_us=%lld mono=%d skew_us=%lld\n",
                  n, (long long)us, (long long)tvUs, mono ? 1 : 0, (long long)skew);
    lastUs = us;
    lastTv = tvUs;
    n++;
    delay(200);
  } else {
    Serial.println("[RTC] rtc-done");
    delay(500);
  }
}
