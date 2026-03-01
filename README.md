# SmartHomeScripts 🏡

## 🇬🇧 English Version

This repository contains my collected scripts and automations for my smart home.

### Structure

-   `/iobroker` - Automatically synchronized files from my production ioBroker instance.
    

### Automated Backup & Up-to-dateness

All scripts offered here (both **JavaScript** and code generated from **Blockly**) originate directly from a **currently running, production system**.

The scripts in the `/iobroker` directory are versioned by an automated cronjob on the host system. As soon as changes to the logic are made and saved in the ioBroker editor (JavaScript adapter), the adapter exports them to the local file system. A background Bash script checks this directory and pushes the changes fully automatically to this `main` branch **within 15 minutes at the latest**.

Thus, this repository reflects the exact state of my live system almost in real-time.

#### Applied Technology

-   **Smart Home Hub:** [ioBroker](https://www.iobroker.net/ "null")
    
-   **Base Adapter:** ioBroker.javascript (with active file mirroring)
    
-   **Additional Adapters:** For the flawless operation of the scripts, further ioBroker adapters are usually required (e.g., for specific hardware or services). Which adapters and instances are strictly necessary for a script can be found in the respective scripts or their comments.
    
-   **Versioning:** Git & Bash automation
    

### Support & Issues

If **Issues** are opened regarding the scripts provided here, please note the following:

-   **No general support:** There are countless hardware and configuration possibilities. I do not offer support for deviating setups. This is strictly subject to the respective hardware or adapter providers.
    
-   **No custom commissioned work:** I do not do "commissioned programming" and will not implement individual and specific requests of individuals, unless these extensions are also useful for my own system.
    

> [!IMPORTANT] **Sensitive data such as API keys or passwords are not included in the source code**, but are securely loaded via local ioBroker data points (`0_userdata.0...`). If these data points do not exist in your own ioBroker instance, they must be created manually and filled with your own, correct data prior to executing the scripts.

## 🇩🇪 Deutsche Version

Dieses Repository enthält meine gesammelten Skripte und Automatisierungen für mein Smart Home.

### Struktur

-   `/iobroker` - Automatisch synchronisierte Dateien aus meiner produktiven ioBroker-Instanz.
    

### Automatisches Backup & Aktualität

Alle hier angebotenen Skripte (sowohl **JavaScript** als auch aus **Blockly** generierter Code) stammen direkt aus einem **aktuell laufenden, produktiven System**.

Die Skripte im Ordner `/iobroker` werden durch einen automatischen Cronjob auf dem Host-System versioniert. Sobald im ioBroker-Editor (JavaScript-Adapter) Änderungen an der Logik vorgenommen und gespeichert werden, exportiert der Adapter diese in das lokale Dateisystem. Ein im Hintergrund laufendes Bash-Skript prüft dieses Verzeichnis und pusht die Änderungen **spätestens nach 15 Minuten** vollautomatisch in diesen `main`-Branch.

Dadurch spiegelt dieses Repository nahezu in Echtzeit den exakten Stand meines Live-Systems wider.

#### Eingesetzte Technik

-   **Smart Home Zentrale:** [ioBroker](https://www.iobroker.net/ "null")
    
-   **Basis-Adapter:** ioBroker.javascript (mit aktivierter Datei-Spiegelung)
    
-   **Zusätzliche Adapter:** Für den einwandfreien Betrieb der Skripte werden in der Regel weitere ioBroker-Adapter benötigt (z. B. für spezifische Hardware oder Dienste). Welche Adapter und Instanzen für ein Skript zwingend erforderlich sind, ist den jeweiligen Skripten bzw. deren Kommentaren zu entnehmen.
    
-   **Versionierung:** Git & Bash-Automatisierung
    

### Support & Issues

Sofern **Issues** zu den hier bereitgestellten Skripten eröffnet werden, beachtet bitte Folgendes:

-   **Kein allgemeiner Support:** Es gibt unzählige Hardware- und Konfigurationsmöglichkeiten. Ich biete keinen Support für abweichende Setups an. Dies unterliegt ausschließlich den jeweiligen Hardware- oder Adapter-Anbietern.
    
-   **Keine individuellen Auftragsarbeiten:** Ich führe keine "Auftragsprogrammierung" aus und setze keine individuellen und spezifischen Wünsche Einzelner um, sofern diese Erweiterungen nicht auch meinem eigenen System sachdienlich sind.
