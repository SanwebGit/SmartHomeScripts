   // ================================ ============                                 
   // Automatische Bettbeleuchtung mit Nacht-Logik                                  
   // ================================ ============                                 
   // Logik: Licht nur bei Nacht, wenn Kontaktmatte=false UND Bewegung=true         
   // Timer: 2 Minuten, retriggert bei erneuter Bewegung                            
   // ================================ ============                                 
(function() {                                                                    
     "use strict";                                                                                    
   // Konfiguration                                                                 
   const TIMER_MS = 2 * 60 * 1000; // 2 Minuten                                     
                                                                                    
   // Datenpunkte                                                                   
   const DP = {                                                                     
     links: {                                                                       
       led:      'zigbee2mqtt.0.0xa4c13852a863096b.state',                          
       motion:   'zigbee2mqtt.0.0xa4c1387d7ee56494.presence',                       
       matte:    'hm-rpc.0.001E1D899E94B0.1.STATE'                                  
     },                                                                             
     rechts: {                                                                      
       led:      'zigbee2mqtt.0.0xa4c138da7c22e582.state',                          
       motion:   'zigbee2mqtt.0.0xa4c138f5aeea45b6.presence',                       
       matte:    'hm-rpc.0.001E1D899E922D.1.STATE'                                  
     },                                                                             
     nacht:    '0_userdata.0.System.Astro.TagNacht'                                 
   };                                                                               
                                                                                    
   // Timer-Referenzen                                                              
   let timerLinks = null;                                                           
   let timerRechts = null;                                                          
                                                                                    
   // ================================ ============                                 
   // Hilfsfunktion: Licht steuern                                                  
   // ================================ ============                                 
   function setLight(side, state) {                                                 
     const ledId = DP[side].led;                                                    
     setState(ledId, state);                                                        
     log(`Licht ${side}: ${state ? 'AN' : 'AUS'}`, 'info');                         
   }                                                                                
                                                                                    
   // ================================ ============                                 
   // Hauptlogik: Seite verarbeiten                                                 
   // ================================ ============                                 
   function processSide(side) {                                                     
     const motionVal = getState(DP[side].motion).val;                               
     const matteVal  = getState(DP[side].matte).val;                                
     const nachtVal = getState(DP.nacht).val;     
                                                                                    
     // Nur bei Nacht verarbeiten                                                   
     if (nachtVal !== 'Nacht') {                                                    
       setLight(side, false);                                                       
       if (timerLinks) { clearTimeout(timerLinks); timerLinks = null; }             
       if (timerRechts) { clearTimeout(timerRechts); timerRechts = null; }          
       return;                                                                      
     }                                                                              
                                                                                    
     // Logik: Matte=false (niemand im Bett) UND Motion=true (Bewegung)             
     if (matteVal === 0 && motionVal === true) {                                    
       // Licht einschalten                                                         
       setLight(side, true);                                                        
                                                                                    
       // Vorherigen Timer löschen                                                  
       if (side === 'links' && timerLinks) { clearTimeout(timerLinks); }            
       if (side === 'rechts' && timerRechts) { clearTimeout(timerRechts); }         
                                                                                    
       // Neuen Timer setzen                                                        
       if (side === 'links') {                                                      
         timerLinks = setTimeout(() => {                                            
           setLight('links', false);                                                
           timerLinks = null;                                                       
         }, TIMER_MS);                                                              
       } else {                                                                     
         timerRechts = setTimeout(() => {                                           
           setLight('rechts', false);                                               
           timerRechts = null;                                                      
         }, TIMER_MS);                                                              
       }                                                                            
                                                                                    
       log(`Timer ${side} gestartet (2 Min)`, 'debug');                             
     } else if (matteVal === 1) {                                                   
       // Person im Bett → Licht aus, Timer löschen                                 
       setLight(side, false);                                                       
       if (side === 'links' && timerLinks) { clearTimeout(timerLinks); timerLinks = 
 null; }                                                                            
       if (side === 'rechts' && timerRechts) { clearTimeout(timerRechts);           
 timerRechts = null; }                                                              
       log(`Seite ${side}: Person im Bett, Licht bleibt AUS`, 'debug');             
     }                                                                              
   }                                                                                
                                                                                    
   // ================================ ============                                 
   // Trigger: Bewegung links                                                       
   // ================================ ============                                 
   on(DP.links.motion, function() {                                                 
     processSide('links');                                                          
   });                                                                              
                                                                                    
   // ================================ ============                                 
   // Trigger: Bewegung rechts                                                      
   // ================================ ============                                 
   on(DP.rechts.motion, function() {                                                
     processSide('rechts');                                                         
   });                                                                              
                                                                                    
   // ================================ ============                                 
   // Trigger: Kontaktmatte links                                                   
   // ================================ ============                                 
   on(DP.links.matte, function() {                                                  
     processSide('links');                                                          
   });                                                                              
                                                                                    
   // ================================ ============                                 
   // Trigger: Kontaktmatte rechts                                                  
   // ================================ ============                                 
   on(DP.rechts.matte, function() {                                                 
     processSide('rechts');                                                         
   });                                                                              
                                                                                    
   // ================================ ============                                 
   // Trigger: Tag/Nacht Wechsel                                                    
   // ================================ ============                                 
   on(DP.nacht, function() {                                                        
     const nachtVal = getState(DP.nacht).val;                                       
                                                                                    
     if (nachtVal === 'Tag') {                                                      
       // Tag → beide Lichter aus, Timer löschen                                    
       setLight('links', false);                                                    
       setLight('rechts', false);                                                   
       if (timerLinks) { clearTimeout(timerLinks); timerLinks = null; }             
       if (timerRechts) { clearTimeout(timerRechts); timerRechts = null; }          
       log('Tag erkannt → Beleuchtung deaktiviert', 'info');                        
     } else {                                                                       
       log('Nacht erkannt → Beleuchtung aktiv', 'info');                            
       // Bei Nacht-Wechsel beide Seiten prüfen                                     
       processSide('links');                                                        
       processSide('rechts');                                                       
     }                                                                              
   });                                                                              
                                                                                    
   // ================================ ============                                 
   // Initialisierung beim Start                                                    
   // ================================ ============                                 
   log('Bettbeleuchtung-Skript gestartet', 'info');                                 
   processSide('links');                                                            
   processSide('rechts');
   
   })(); 