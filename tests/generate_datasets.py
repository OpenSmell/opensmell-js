#!/usr/bin/env python3
import csv, os, random
OUT = os.path.join(os.path.dirname(__file__), 'datasets')
os.makedirs(OUT, exist_ok=True)
random.seed(42)
PHASES = ['intake','hold','purge','report']
BASE_T, BASE_RH = 22.5, 45.0
def noise(amp=0.01): return random.uniform(-amp, amp)
def make_rows(t, n=20, anomaly=False):
    rows=[]; ts=0
    for c in range(n):
        for ph in PHASES:
            r={'cycle_id':c+1,'phase':ph,'timestamp_ms':ts,'sensor_type':t,'sensor_model':f'TEST-{t}',
               'analog_value_v':None,'digital_value':None,'frequency_hz':None,'current_ua':None,'ppm':None,
               'index':None,'ph':None,'temperature_c':round(BASE_T+noise(0.3),2),'humidity_pct':round(BASE_RH+noise(1.0),2),
               'qc_flag_injected':'','expected_state':'ready'}; ts+=10000
            if t=='MOX':
                bv={'intake':1.20,'hold':1.25,'purge':1.30,'report':1.30}[ph]
                r['analog_value_v']=round(bv+noise(0.002),3)
                if anomaly and c>=n//2 and ph=='hold':
                    r['analog_value_v']=round(r['analog_value_v']+0.05*(c-n//2+1),3)
                    r['qc_flag_injected']='baseline_drift'
            elif t=='NDIR':
                r['ppm']=round(400+noise(2.0),1)
                if anomaly and c>=n//2:
                    r['ppm']=round(r['ppm']+50.0,1)
                    r['qc_flag_injected']='out_of_range'
            elif t=='PID':
                r['analog_value_v']=round(0.150+noise(0.001),3)
                if anomaly and c>=n//2:
                    r['analog_value_v']=3.3
                    r['qc_flag_injected']='adc_saturation'
            elif t=='Electrochemical':
                r['current_ua']=round(50.0+noise(0.5),2)
                if anomaly and c>=n//2 and ph=='hold':
                    r['current_ua']=round(r['current_ua']+2.0*(c-n//2+1),2)
                    r['qc_flag_injected']='baseline_drift'
            elif t=='Galvanic':
                r['current_ua']=round(100.0+noise(1.0),2)
            elif t=='CatalyticBead':
                r['analog_value_v']=round(0.8+noise(0.005),3)
            elif t=='QCM':
                r['frequency_hz']=10_000_000+noise(10.0)
                if anomaly and c>=n//2:
                    r['frequency_hz']=10_000_000
                    r['qc_flag_injected']='sensor_fault'
                    r['expected_state']='fault'
            elif t=='SAW':
                r['frequency_hz']=433_000_000+noise(100.0)
            elif t=='Cantilever':
                r['frequency_hz']=50_000+noise(5.0)
            elif t=='Polymer':
                r['analog_value_v']=round(1.0+noise(0.003),3)
            elif t=='SolidElectrolyte':
                r['current_ua']=round(200.0+noise(2.0),2)
            elif t=='pH_ISFET':
                r['analog_value_v']=round(0.414+noise(0.001),3)
            elif t=='Env_TRH':
                r['analog_value_v']=round(BASE_T+noise(0.3),2)
                r['digital_value']=round(BASE_RH+noise(1.0),2)
            elif t=='MEMS':
                r['index']=round(350+noise(5.0),1)
            rows.append(r)
    return rows
TYPES=['MOX','NDIR','PID','Electrochemical','Galvanic','CatalyticBead','QCM','SAW','Cantilever','Polymer','SolidElectrolyte','pH_ISFET','Env_TRH','MEMS']
FIELDS=['cycle_id','phase','timestamp_ms','sensor_type','sensor_model','analog_value_v','digital_value','frequency_hz','current_ua','ppm','index','ph','temperature_c','humidity_pct','qc_flag_injected','expected_state']
for t in TYPES:
    for tag,rows in [('clean',make_rows(t,False)),('anomaly',make_rows(t,True))]:
        p=os.path.join(OUT,f'{t.lower()}_{tag}.csv')
        with open(p,'w',newline='') as f:
            w=csv.DictWriter(f,fieldnames=FIELDS); w.writeheader(); w.writerows(rows)
        print(f'Wrote {p} ({len(rows)} rows)')
print('Done.')
