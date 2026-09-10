// Validation sketch: connects to WiFi (via the emulator's virtual radio),
// prints the DHCP IP, performs an HTTP GET, and prints the result.
// In-sim the frames travel through the OpenHW gateway (gVisor NAT).
#include <WiFi.h>
#include <HTTPClient.h>

void setup() {
    Serial.begin(115200);
    Serial.println("wifi-start");
    WiFi.mode(WIFI_STA);
    WiFi.begin("testssid", "testpass");
    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 30000) {
        delay(500);
        Serial.print(".");
    }
    Serial.println();
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("wifi-connect FAIL");
        return;
    }
    Serial.print("wifi-ip=");
    Serial.println(WiFi.localIP().toString());
    HTTPClient http;
    http.begin("http://example.com/");
    int code = http.GET();
    Serial.printf("http-code=%d\n", code);
    if (code > 0) {
        String body = http.getString();
        Serial.printf("http-len=%d\n", body.length());
        Serial.printf("http-head=%.60s\n", body.c_str());
    }
    http.end();
    Serial.println("wifi-done");
}

void loop() {
    delay(5000);
}
