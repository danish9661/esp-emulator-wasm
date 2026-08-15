#include <Arduino.h>

#define ADC_PIN   0   // GPIO0 = ADC1_CH0 on ESP32-C3
#define PWM_PIN   2   // GPIO2 = LED / PWM pin

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n[ADC/PWM] Starting ADC and PWM / LEDC Demo...");

  pinMode(PWM_PIN, OUTPUT);
  
  // Test analogWrite / LEDC
  analogWrite(PWM_PIN, 128); // 50% duty cycle
  Serial.println("[ADC/PWM] analogWrite(2, 128) configured");

  // Read ADC
  int raw = analogRead(ADC_PIN);
  uint32_t mv = analogReadMilliVolts(ADC_PIN);
  Serial.printf("[ADC/PWM] Initial ADC Read: raw=%d, mv=%u mV\n", raw, mv);
}

void loop() {
  for (int duty = 0; duty <= 255; duty += 51) {
    analogWrite(PWM_PIN, duty);
    int raw = analogRead(ADC_PIN);
    uint32_t mv = analogReadMilliVolts(ADC_PIN);
    Serial.printf("[ADC/PWM] Duty=%d | ADC raw=%d | %u mV\n", duty, raw, mv);
    delay(50);
  }
  Serial.println("[ADC/PWM] adc-pwm-done");
  delay(500);
}
