#include <Arduino.h>

void setup() {
    Serial.begin(115200);
    delay(200);
    Serial.println("[M] before big print");
    for (int i = 0; i < 2000; i++) Serial.print('A');
    Serial.println();
    Serial.println("[M] after big print");
    Serial.println("[M] done");
}

void loop() {
    delay(1000);
}