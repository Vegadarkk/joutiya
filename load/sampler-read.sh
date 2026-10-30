#!/bin/bash
# Load test (D17): summarises the samples of load/sampler-start.sh, per minute since the start: the host's
# busy share (all CPUs) and the CPU each staging container used (cores), then each container's peak.
# Run as root on joutiya-vm: node scripts/oracle-vm.ts run load/sampler-read.sh [--apply]
set -euo pipefail
d=/var/tmp/joutiya-load
[[ -f "$d/raw" ]] || { echo "no samples"; exit 1; }
cat "$d/status" 2>/dev/null || echo running
awk '
$2=="host"{ if (pb!="") { db=$3-pb; di=$4-pi; m=int(($1-t0)/60); if (db+di>0){hs[m]+=100*db/(db+di); hn[m]++} } else t0=$1; pb=$3; pi=$4; next }
{ k=$2; if (k in pu) { m=int(($1-t0)/60); dt=$1-pt[k]; if (dt>0){ c=($3-pu[k])/1e6/dt; cs[m,k]+=c; cn[m,k]++; if(c>pk[k])pk[k]=c; names[k]=1 } } pu[k]=$3; pt[k]=$1 }
END { for (m=0;m<=10;m++) if (hn[m]) { line=sprintf("m%02d host %3.0f%%",m,hs[m]/hn[m]); for (k in names) if (cn[m,k]) line=line sprintf(" %s %.2f",substr(k,1,6),cs[m,k]/cn[m,k]); print line }
  line="peak"; for (k in names) line=line sprintf(" %s %.2f",substr(k,1,6),pk[k]); print line }' "$d/raw"
