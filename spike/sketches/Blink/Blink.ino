// Validation sketch: toggles GPIO2 so the emulator's GPIO_OUT word can be watched.
void setup() {
  Serial.begin(115200);
  pinMode(2, OUTPUT);
  Serial.println("blink-start");
}

void loop() {
  digitalWrite(2, HIGH);
  delay(50);
  digitalWrite(2, LOW);
  delay(50);
}
