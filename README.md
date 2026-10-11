# AbyssLink

### Smart Submarine Cable Protection and Laser Data Transmission Monitoring System

AbyssLink is an industrial-style hardware monitoring dashboard and firmware system designed for a benchtop submarine cable protection prototype. The system uses an ESP32 microcontroller paired with optical laser data transmission, an LDR optical receiver, an ultrasonic proximity sensor, a digital seismic/vibration sensor, and an acoustic buzzer alarm.

The dashboard connects directly to the ESP32 over native USB Serial using the browser's native **Web Serial API**—requiring zero external backend servers, cloud databases, or third-party drivers.

---

## 1. Project Overview & Folder Structure

```
AbyssLink/
│
├── website/
│   ├── index.html     # Semantic HTML5 dashboard layout
│   ├── style.css      # Minimalist industrial CSS styling
│   └── script.js      # Web Serial API handler, JSON parser, and UI state engine
│
├── esp32/
│   └── AbyssLink_ESP32.ino # Complete ESP32 firmware with non-blocking timing
│
└── README.md          # Comprehensive technical documentation & setup guide
```

---

## 2. Hardware Components & Bill of Materials

1. **ESP32 Development Board** (NodeMCU-32S, ESP32-WROOM-32, or equivalent)
2. **Laser Transmitter Module** (650 nm red laser diode module, 5V / 3.3V compatible)
3. **LDR Light Dependent Resistor Sensor Module** (with digital comparator output DO)
4. **Ultrasonic Distance Sensor** (HC-SR04 or compatible 5V/3.3V module)
5. **Digital Vibration / Shock Sensor Module** (SW-420 or ball-tilt digital module)
6. **Active Buzzer Alarm Module** (3.3V / 5V buzzer module)
7. **Resistors / Voltage Divider** (1kΩ and 2kΩ resistors for 5V HC-SR04 ECHO level shifting)
8. **USB-A to Micro-USB / USB-C Cable** (must support high-speed data transfer, not power-only)
9. **Solderless Breadboard & Dupont Jumper Wires**

---

## 3. Existing Hardware Pin Mapping

| Component | Component Pin | ESP32 GPIO | Direction | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Laser Transmitter** | Signal / VCC | **GPIO 25** | Output | High = Laser ON, Low = Laser OFF |
| **Ultrasonic Sensor** | TRIG | **GPIO 5** | Output | 10 µs trigger pulse |
| **Ultrasonic Sensor** | ECHO | **GPIO 18** | Input | Pulse width proportional to distance |
| **LDR Receiver Module**| DO (Digital Out) | **GPIO 34** | Input | Input-only GPIO (ADC1) |
| **Vibration Sensor** | DO (Digital Out) | **GPIO 27** | Input | High = Vibration detected |
| **Active Buzzer Module**| Signal | **GPIO 26** | Output | High = Sounder active |

*Serial Baud Rate:* **115200**

---

## 4. Electrical Safety & Wiring Notes

1. **GPIO 34 Input-Only Constraint:**  
   GPIO 34 on the ESP32 is an input-only pin without internal software pull-up or pull-down resistors. Ensure your LDR module features an onboard comparator (such as LM393) that provides a driven push-pull or pull-up digital output.
2. **Ultrasonic ECHO Voltage Level Shifting:**  
   Standard HC-SR04 sensors operate at 5V and output 5V on the ECHO pin. Because the ESP32 GPIO pins are rated for 3.3V logic, running 5V directly into GPIO 18 can damage the microcontroller over time. Use a simple two-resistor voltage divider (e.g., 1kΩ in series with ECHO, 2kΩ to GND) or a 3.3V-tolerant ultrasonic sensor (such as HC-SR04P or RCWL-1601).
3. **Laser Radiation Safety:**  
   Always keep the laser pointed directly into the LDR receiver hood or target. Never point the laser into human eyes.
4. **Common Ground:**  
   Ensure all modules (Laser, LDR, Ultrasonic, Vibration, Buzzer) share a common GND rail with the ESP32.

---

## 5. Software Requirements

* **Operating System:** Windows 10/11, macOS, or Linux.
* **Browser:** Desktop Chromium-based browser supporting the native Web Serial API:
  * Google Chrome (version 89+)
  * Microsoft Edge (version 89+)
  * Opera / Brave (latest versions)
  * *Note: Firefox and Safari do not support the Web Serial API.*
* **Firmware Toolchain:** Arduino IDE 1.8.x or 2.x, or VS Code with Arduino / PlatformIO extension.
* **ESP32 Board Package:** `esp32` by Espressif Systems (v2.0.x or newer).

---

## 6. Arduino IDE Firmware Upload Steps

1. Launch **Arduino IDE**.
2. Go to **File → Open** and select `AbyssLink/esp32/AbyssLink_ESP32.ino`.
3. In **Tools → Board**, select **ESP32 Dev Module** (or your specific board model).
4. Connect the ESP32 to your PC using a known data-capable USB cable.
5. In **Tools → Port**, select the COM port corresponding to your ESP32 (e.g., `COM3`, `COM4`, `/dev/ttyUSB0`).
6. Click **Upload** (arrow icon). If your board requires manual boot mode, hold down the `BOOT` button on the ESP32 until uploading begins.
7. Wait until the IDE console reports `Done uploading` and `Hard resetting via RTS pin...`.

---

## 7. CRITICAL: Serial Port Conflict Warning

> **IMPORTANT:** USB Serial COM ports are exclusive single-process resources. A COM port cannot be accessed simultaneously by both the Arduino IDE Serial Monitor and the web browser.
> 
> **You MUST close the Arduino IDE Serial Monitor before clicking "Connect Device" on the website.**
> 
> If the Arduino Serial Monitor remains open, the browser will encounter an `Access Denied` or `Failed to open serial port` error.

---

## 8. Running the Website Locally

Because the Web Serial API requires a secure context (`localhost` or `https://`), you should serve the `website/` directory using any lightweight local HTTP server.

### Option A: Using Python (Recommended)
Open a terminal in the project directory and run:
```bash
# Navigate to the website folder
cd AbyssLink/website

# Start local server on port 8000
python -m http.server 8000
```
Then open your browser to: `http://localhost:8000`

### Option B: Using Node.js (npx serve)
```bash
cd AbyssLink/website
npx -y serve .
```

### Option C: VS Code Live Server Extension
Open the `AbyssLink/website` directory in VS Code, right-click `index.html`, and select **Open with Live Server**.

---

## 9. Connecting the ESP32 via Browser

1. Open `http://localhost:8000` in Google Chrome or Microsoft Edge.
2. Verify that the top header shows `DISCONNECTED` with a neutral grey indicator.
3. Click the **Connect Device** button in the top right.
4. A native browser dialog will appear titled **"website wants to connect to a serial port"**.
5. Select your ESP32 device (usually listed as `CP210x USB to UART Bridge`, `CH340`, or `USB Serial Port`) and click **Connect**.
6. The connection indicator will turn green (`CONNECTED`), and the dashboard cards will immediately begin streaming real-time sensor data at ~300 ms intervals.

---

## 10. Starting and Stopping Laser Data Transmission

1. Once connected, the **Start Sending Data** button in the *Laser Transmission Channel* card will become enabled.
2. Click **Start Sending Data**:
   * The browser transmits the command `START_TRANSMISSION\n`.
   * The ESP32 switches the laser GPIO 25 HIGH and replies with `{"type":"ack","command":"START_TRANSMISSION","success":true,"transmission":true}`.
   * The website updates the channel status to **TRANSMISSION ACTIVE**.
   * The LDR interruption monitoring automatically arms.
3. Click **Stop Sending Data**:
   * The browser transmits `STOP_TRANSMISSION\n`.
   * The ESP32 switches the laser GPIO 25 LOW and replies with `{"type":"ack","command":"STOP_TRANSMISSION","success":true,"transmission":false}`.
   * The website updates the status to **TRANSMISSION STOPPED**.
   * The LDR card displays **TRANSMISSION INACTIVE**—this intentional laser shutdown **does not** trigger a false alarm.

---

## 11. Sensor Logic, Thresholds & Alarm Hierarchy

### Optical LDR Receiver
* **Laser Light Reaches LDR:** Digital input `LOW` (0) → Status: `SIGNAL RECEIVED` (Normal, no buzzer).
* **Laser Light Blocked / Lost:** Digital input `HIGH` (1) while transmission is active → Status: `SIGNAL INTERRUPTED` (Continuous buzzer alarm).
* **Transmission Inactive:** LDR alarm is disarmed so turning off the laser does not cause a false alarm.

### Ultrasonic Proximity Radar
* **Distance > 80 cm:** `SAFE` → Buzzer OFF.
* **Distance 51–80 cm:** `WARNING` → Slow intermittent beeping (250 ms ON, 500 ms OFF).
* **Distance 6–50 cm:** `DANGER` → Fast intermittent beeping (100 ms ON, 100 ms OFF).
* **Distance ≤ 5 cm:** `CRITICAL` → Continuous alarm.
* **No Echo Received:** Displays `NO ECHO` / `UNAVAILABLE`. It is never treated as 0 cm or CRITICAL.

### Seismic / Vibration Sensor
* **Digital LOW (0):** `NORMAL` → Normal state.
* **Digital HIGH (1):** `VIBRATION DETECTED` → Continuous alarm. Operates independently even if optical transmission is stopped.

### Hardware Buzzer Priority Hierarchy
The ESP32 firmware evaluates hardware alert conditions in strict order:
1. **Laser Interruption during active transmission** (Continuous alarm)
2. **Vibration detected** (Continuous alarm)
3. **Critical object proximity ≤ 5 cm** (Continuous alarm)
4. **Proximity danger zone 6–50 cm** (Fast intermittent beep)
5. **Proximity warning zone 51–80 cm** (Slow intermittent beep)
6. **Safe / Nominal conditions** (Buzzer OFF)

---

## 12. Serial Communication Protocol

### Sensor Telemetry (ESP32 → Browser, Every 300 ms)
Newline-delimited JSON payload:
```json
{"type":"sensor","transmission":true,"ldr":0,"vibration":0,"distance_cm":125.4,"distance_valid":true,"laser":"ON","buzzer":"OFF","alert":"SAFE"}
```
Unavailable distance format:
```json
{"type":"sensor","transmission":true,"ldr":0,"vibration":0,"distance_cm":null,"distance_valid":false,"laser":"ON","buzzer":"OFF","alert":"DISTANCE_UNAVAILABLE"}
```

### Commands & Acknowledgements
* **Website → ESP32:** `START_TRANSMISSION\n`  
  **ESP32 → Website:** `{"type":"ack","command":"START_TRANSMISSION","success":true,"transmission":true}`
* **Website → ESP32:** `STOP_TRANSMISSION\n`  
  **ESP32 → Website:** `{"type":"ack","command":"STOP_TRANSMISSION","success":true,"transmission":false}`

---

## 13. Troubleshooting Serial Connection Errors

| Symptom | Cause | Solution |
| :--- | :--- | :--- |
| **"Serial Unsupported" banner appears** | Browser does not support Web Serial API | Use desktop Google Chrome or Microsoft Edge. |
| **"Failed to open serial port" / Access Denied** | Port is locked by another program | Close Arduino IDE Serial Monitor, Cura, PuTTY, or terminal monitors. |
| **No COM port visible in browser popup** | Missing USB UART drivers or charge-only cable | Install CP210x or CH340 drivers; swap to a data USB cable. |
| **Data Stale warning (> 2s)** | ESP32 stalled, disconnected, or reset | Check physical USB connection; reset ESP32 via EN button. |
| **Distance shows "NO ECHO"** | Ultrasonic sensor wiring loose or object out of range | Verify TRIG (GPIO 5) and ECHO (GPIO 18) connections and 5V power. |
| **LDR always reads 1** | Inverted module or sensitivity potentiometer unset | Adjust potentiometer on LM393 comparator board. |

---

## 14. Static Deployment to Vercel

The website is composed entirely of static assets (`index.html`, `style.css`, `script.js`).

1. Install Vercel CLI or link your Git repository to [Vercel](https://vercel.com).
2. Configure project root to `AbyssLink/website` or deploy from root.
3. Once deployed, access the dashboard over HTTPS (e.g. `https://your-abysslink.vercel.app`).
4. **Local Hardware Access:** The deployed Vercel website communicates directly with the ESP32 plugged into the user's local USB port via client-side Web Serial API. No server-side code or cloud relay is required.

---

## 15. Prototype Disclaimers & Limitations

* **Benchtop Simulation Only:** This project is an educational and functional proof-of-concept prototype.
* **Sensor Limitations:** Standard HC-SR04 ultrasonic sensors use open piezoelectric transducers designed for ambient air and are **not waterproof**; do not submerge them in water.
* **Optical Alignment:** Atmospheric laser transmission is sensitive to physical alignment between the laser diode and the photoresistor aperture.
