#include <Arduino.h>

// Hardware timer test (native silicon: GPTimer + interrupt, no shims).
// A 1MHz timer with autoreload alarm every 100000 ticks (=100ms) fires an ISR
// that bumps a counter; loop() reports ticks. Proves timer groups +
// interrupt delivery work in the emulator.

static hw_timer_t *gTimer = nullptr;
static volatile uint32_t gTicks = 0;

void ARDUINO_ISR_ATTR onTimerISR() {
  gTicks++;
}

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("[TIMER] Timer demo start");
  gTimer = timerBegin(1000000);  // 1 MHz base
  timerAttachInterrupt(gTimer, onTimerISR);
  timerAlarm(gTimer, 100000, true, 0);  // 100ms autoreload
  timerStart(gTimer);
  Serial.println("[TIMER] 100ms periodic alarm started");
}

void loop() {
  static uint32_t last = 0;
  static int reports = 0;
  uint32_t t = gTicks;
  if (t != last) {
    last = t;
    reports++;
    Serial.printf("[TIMER] tick=%u\n", t);
  }
  if (reports >= 5) {
    timerStop(gTimer);
    timerDetachInterrupt(gTimer);
    timerEnd(gTimer);
    Serial.printf("[TIMER] total=%u timer-done\n", t);
    delay(500);
  } else {
    delay(20);
  }
}
