// Validation sketch: connects to WiFi (via the emulator's virtual radio),
// prints the DHCP IP, performs HTTP + HTTPS GETs, then an MQTT
// subscribe/publish round trip. In-sim the frames travel through the
// OpenHW gateway (gVisor NAT).
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>

static bool mqttGot = false;
static void onMqtt(char* topic, byte* payload, unsigned int len) {
    String s;
    for (unsigned int i = 0; i < len; i++) s += (char)payload[i];
    if (String(topic) == "espemu/wifidemo/rx" && s == "ping-espemu") {
        mqttGot = true;
    }
}

void setup() {
    Serial.begin(115200);
    Serial.println("wifi-start");
    // Test rig sends "URLBASE <ip>" to point HTTP/HTTPS/MQTT at local
    // servers (deterministic, no internet roulette). Default: this lab.
    String base = "10.171.253.228";
    unsigned long w0 = millis();
    String line;
    while (millis() - w0 < 5000) {
        while (Serial.available()) {
            char ch = (char)Serial.read();
            if (ch == '\n' || ch == '\r') {
                if (line.startsWith("URLBASE ")) {
                    base = line.substring(8);
                    base.trim();
                }
                line = "";
            } else if (line.length() < 40) {
                line += ch;
            }
        }
        if (base != "10.171.253.228") break;
        delay(50);
    }
    Serial.print("urlbase=");
    Serial.println(base);
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
    http.begin(("http://" + base + ":18081/").c_str());
    http.setTimeout(20000);
    int code = http.GET();
    Serial.printf("http-code=%d\n", code);
    if (code <= 0) {
        Serial.printf("http-err=%s\n", http.errorToString(code).c_str());
    }
    if (code > 0) {
        String body = http.getString();
        Serial.printf("http-len=%d\n", body.length());
        Serial.printf("http-head=%.60s\n", body.c_str());
    }
    http.end();
    Serial.println("wifi-done");

    // HTTPS through the same path (TLS handshake = many round trips).
    WiFiClientSecure tls;
    tls.setInsecure();
    HTTPClient htls;
    htls.begin(tls, ("https://" + base + ":18444/").c_str());
    htls.setTimeout(20000);
    int tcode = htls.GET();
    Serial.printf("https-code=%d\n", tcode);
    if (tcode > 0) {
        String tbody = htls.getString();
        Serial.printf("https-len=%d\n", tbody.length());
    }
    htls.end();
    Serial.println("tls-done");

    // MQTT pub/sub round trip against the local test broker
    // (spike/mqtt_broker.mjs on the host LAN IP — deterministic dotted
    // quad, no DNS needed; HTTP/HTTPS above already prove egress).
    WiFiClient net;
    PubSubClient mqtt(net);
    mqtt.setServer(base.c_str(), 1886);
    mqtt.setCallback(onMqtt);
    mqtt.setSocketTimeout(15);
    unsigned long m0 = millis();
    String cid = "espemu-" + String((uint32_t)ESP.getEfuseMac(), HEX) + "-" + String(m0, HEX);
    bool mconn = mqtt.connect(cid.c_str());
    Serial.printf("mqtt-connect=%d\n", mconn ? 1 : 0);
    if (!mconn) {
        Serial.printf("mqtt-state=%d\n", mqtt.state());
    }
    if (mconn) {
        mqtt.subscribe("espemu/wifidemo/rx");
        mqtt.publish("espemu/wifidemo/rx", "ping-espemu");
        while (!mqttGot && millis() - m0 < 25000) {
            mqtt.loop();
            delay(100);
        }
        Serial.printf("mqtt-got=%d\n", mqttGot ? 1 : 0);
        mqtt.disconnect();
    }
    Serial.println("mqtt-done");
}

void loop() {
    delay(5000);
}
