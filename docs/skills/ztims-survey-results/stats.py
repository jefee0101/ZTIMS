#!/usr/bin/env python3
"""Survey statistics for ZTIMS.
  stats.py --counts c1 c2 c3 c4 c5        counts of ratings 1..5 -> N, WM, sample SD, interpretation
  stats.py --scores 4 5 3 ...             raw scores 1..5
  stats.py --freq 33 25 18 --n 40         frequency and percentage per option (multiple response ok)
  --bands 1.80 2.60 3.40 4.20 --labels 'Very Poor,Poor,Moderate,Good,Excellent'   custom upper limits and names"""
import argparse, math, sys

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--counts', type=int, nargs='+'); ap.add_argument('--scores', type=float, nargs='+')
    ap.add_argument('--freq', type=int, nargs='+'); ap.add_argument('--n', type=int)
    ap.add_argument('--bands', type=float, nargs='+', default=[1.80, 2.60, 3.40, 4.20])
    ap.add_argument('--labels', default='Very Poor,Poor,Moderate,Good,Excellent')
    a = ap.parse_args()
    labels = a.labels.split(',')
    if len(labels) != len(a.bands) + 1: sys.exit('need one more label than bands')
    if a.freq:
        if not a.n: sys.exit('--n is required with --freq')
        for k, f in enumerate(a.freq, 1): print(f'option {k}: f = {f}, % = {100 * f / a.n:.2f}')
        print(f'(percentages add to {100 * sum(a.freq) / a.n:.2f}%; above 100 means multiple response)'); return
    if a.counts:
        scores = [i + 1 for i, c in enumerate(a.counts) for _ in range(c)]
    elif a.scores: scores = a.scores
    else: sys.exit('give --counts, --scores or --freq')
    n = len(scores); mean = sum(scores) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in scores) / (n - 1)) if n > 1 else float('nan')
    # interpretation on the rounded-to-2-decimals mean, as the tables report it
    m2 = round(mean + 1e-9, 2)
    label = labels[sum(1 for b in a.bands if m2 > b)]
    print(f'N = {n}\nWM = {mean:.2f}\nSD (sample) = {sd:.2f}\nInterpretation = {label}')
    if m2 != round(mean, 4): print(f'(mean {mean:.4f} is reported as {m2:.2f})')

if __name__ == '__main__':
    main()
