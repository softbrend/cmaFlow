#!/usr/bin/env python3
"""
Semantic-Role Inference evaluation — Step 2 of 2 (Python).

Computes everything Section 5.2 / Table 3 / the Abstract / the
Conclusion of the manuscript need for CAAGA's Semantic-Role Inference
accuracy, following the procedure described in Section 4.4:

  1. Cohen's kappa for the two raters' INDEPENDENT labels, before
     resolution (inter-rater agreement).
  2. Per-role precision, recall, and F1, plus the macro-averaged F1,
     comparing CAAGA's inferred role against the raters' RESOLVED
     (consensus) label — this is Table 3.
  3. The most frequent confusions (e.g. quantity vs monetary), to write
     the "[Summarise the strongest and weakest roles ...]" sentence.
  4. An optional baseline comparison (e.g. physical-type-only role
     guessing, or an existing profiling tool), scored the same way, if
     you provide predictions for it.

Inputs
------
  --predictions   caaga_role_predictions.csv
                  Produced by scripts/exportSemanticRoleEvaluation.js,
                  which runs CAAGA's REAL engine (services/
                  semanticFieldEngine.js) against the actual uploaded
                  datasets in cmaDB. Columns used here:
                  dataset_id, file_type, column_name, caaga_role_coarse

  --labels        rater_labels.csv
                  Two human raters' independent labels plus the
                  resolved (consensus) label, for every column CAAGA
                  was scored on. Columns:
                  dataset_id, file_type, column_name,
                  rater1_label, rater2_label, resolved_label
                  (start from rater_labeling_template.csv, which the
                  Node export script also writes, pre-filled with every
                  column's identity — you only need to fill in the
                  three label columns.)

  --baseline      (optional) baseline_predictions.csv with columns
                  dataset_id, file_type, column_name, baseline_role
                  — scored identically to CAAGA for a side-by-side
                  comparison in the paper, if you want one.

All three files key on (dataset_id, file_type, column_name). Labels
must be one of the nine roles below or 'other'. Unlabeled or
unresolved rows are dropped from the accuracy computation (reported
separately) rather than silently guessed at — the same honest-
degradation discipline the app itself follows.

Usage
-----
    pip install pandas scikit-learn
    python evaluate_semantic_role_inference.py \\
        --predictions caaga_role_predictions.csv \\
        --labels rater_labels.csv

Output
------
  - Printed to the console: inter-rater kappa, Table 3 (precision/
    recall/F1 per role + macro average), the 'other' residual class
    reported separately, and the most frequent confusions.
  - table3_semantic_role_accuracy.csv and .md written to disk, ready
    to paste into the manuscript.
"""
import argparse
import sys

import pandas as pd
from sklearn.metrics import cohen_kappa_score, confusion_matrix, precision_recall_fscore_support

# The manuscript's Table 3 role vocabulary (Section 4.4 / 5.2). 'other'
# is a valid label for a column that fits none of the nine, but is
# reported separately, not folded into the macro average — Table 3 has
# nine named rows plus a "Macro average" row, no "other" row.
ROLES = [
    'Identifier', 'Date/time', 'Monetary amount', 'Quantity', 'Category',
    'Rating', 'Geography', 'Status', 'Free text',
]
OTHER = 'other'
KEY_COLS = ['dataset_id', 'file_type', 'column_name']


def load_and_merge(predictions_path, labels_path, pred_col, label_col='resolved_label'):
    preds = pd.read_csv(predictions_path)
    labels = pd.read_csv(labels_path)

    missing_pred_cols = [c for c in KEY_COLS + [pred_col] if c not in preds.columns]
    if missing_pred_cols:
        sys.exit(f"ERROR: {predictions_path} is missing column(s): {missing_pred_cols}")
    missing_label_cols = [c for c in KEY_COLS + [label_col] if c not in labels.columns]
    if missing_label_cols:
        sys.exit(f"ERROR: {labels_path} is missing column(s): {missing_label_cols}")

    merged = labels.merge(preds[KEY_COLS + [pred_col]], on=KEY_COLS, how='left', validate='one_to_one')

    n_total = len(merged)
    unresolved = merged[label_col].isna() | (merged[label_col].astype(str).str.strip() == '')
    unmatched = merged[pred_col].isna()
    if unresolved.any():
        print(f"NOTE: {unresolved.sum()} of {n_total} rows in {labels_path} have no '{label_col}' yet — "
              f"excluded from the accuracy computation. Fill these in before finalizing the paper's numbers.")
    if unmatched.any():
        print(f"NOTE: {unmatched.sum()} row(s) in {labels_path} had no matching prediction in "
              f"{predictions_path} (check dataset_id/file_type/column_name spelling) — excluded.")

    clean = merged[~unresolved & ~unmatched].copy()

    bad_labels = set(clean[label_col].unique()) - set(ROLES + [OTHER])
    if bad_labels:
        sys.exit(f"ERROR: {label_col} contains label(s) not in the nine-role vocabulary or 'other': "
                  f"{sorted(bad_labels)} — fix the labels CSV (check spelling/capitalization) and re-run.")

    return clean, unresolved.sum(), unmatched.sum()


def inter_rater_kappa(labels_path):
    """Cohen's kappa between the two raters' INDEPENDENT labels, before
    resolution — Section 4.4/5.2's "inter-rater agreement before
    resolution was measured with Cohen's kappa." Uses every row where
    BOTH raters gave a label, regardless of whether resolution/CAAGA
    matching happened yet."""
    labels = pd.read_csv(labels_path)
    for col in ('rater1_label', 'rater2_label'):
        if col not in labels.columns:
            print(f"WARNING: {labels_path} has no '{col}' column — skipping inter-rater kappa.")
            return None, 0
    both_rated = labels.dropna(subset=['rater1_label', 'rater2_label'])
    both_rated = both_rated[
        (both_rated['rater1_label'].astype(str).str.strip() != '') &
        (both_rated['rater2_label'].astype(str).str.strip() != '')
    ]
    if len(both_rated) < 2:
        print("WARNING: fewer than 2 fully double-rated rows — cannot compute kappa yet.")
        return None, len(both_rated)
    kappa = cohen_kappa_score(both_rated['rater1_label'], both_rated['rater2_label'])
    return kappa, len(both_rated)


def score(y_true, y_pred, labels):
    precision, recall, f1, support = precision_recall_fscore_support(
        y_true, y_pred, labels=labels, average=None, zero_division=0
    )
    macro_p, macro_r, macro_f1, _ = precision_recall_fscore_support(
        y_true, y_pred, labels=labels, average='macro', zero_division=0
    )
    per_role = pd.DataFrame({
        'Role': labels,
        'Columns (n)': support,
        'Precision': precision,
        'Recall': recall,
        'F1': f1,
    })
    macro_row = pd.DataFrame([{
        'Role': 'Macro average', 'Columns (n)': int(support.sum()),
        'Precision': macro_p, 'Recall': macro_r, 'F1': macro_f1,
    }])
    return pd.concat([per_role, macro_row], ignore_index=True), macro_f1


def report_other_class(y_true, y_pred):
    """'other' isn't in Table 3's nine rows, but its own precision/recall
    is worth knowing: recall here is how often a column CAAGA correctly
    left unresolved was genuinely unclassifiable; precision is how often
    a column CAAGA left unresolved actually had a real, resolvable role
    that CAAGA missed entirely (a false negative worth discussing in the
    paper, distinct from misclassifying one named role as another)."""
    labels_with_other = ROLES + [OTHER]
    precision, recall, f1, support = precision_recall_fscore_support(
        y_true, y_pred, labels=labels_with_other, average=None, zero_division=0
    )
    idx = labels_with_other.index(OTHER)
    return {'n': int(support[idx]), 'precision': precision[idx], 'recall': recall[idx], 'f1': f1[idx]}


def top_confusions(y_true, y_pred, labels, top_n=5):
    """Top off-diagonal (true, predicted) pairs — the 'most frequent
    confusions' Section 5.2 asks you to summarise (e.g. quantity vs
    monetary amount, status vs category)."""
    cm = confusion_matrix(y_true, y_pred, labels=labels)
    pairs = []
    for i, true_role in enumerate(labels):
        for j, pred_role in enumerate(labels):
            if i != j and cm[i][j] > 0:
                pairs.append((cm[i][j], true_role, pred_role))
    pairs.sort(reverse=True)
    return pairs[:top_n]


def print_table(df, title):
    print(f"\n{title}")
    print(df.to_string(index=False, formatters={
        'Precision': '{:.2f}'.format, 'Recall': '{:.2f}'.format, 'F1': '{:.2f}'.format,
    }))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--predictions', default='caaga_role_predictions.csv',
                     help='CAAGA predictions CSV from exportSemanticRoleEvaluation.js (default: %(default)s)')
    ap.add_argument('--labels', default='rater_labels.csv',
                     help='Two-rater + resolved-label CSV (default: %(default)s)')
    ap.add_argument('--baseline', default=None,
                     help='Optional baseline_predictions.csv for a side-by-side comparison')
    args = ap.parse_args()

    kappa, n_double_rated = inter_rater_kappa(args.labels)
    if kappa is not None:
        print(f"Inter-rater agreement (Cohen's kappa, n={n_double_rated} double-rated columns, "
              f"before resolution): kappa = {kappa:.2f}")

    clean, n_unresolved, n_unmatched = load_and_merge(args.predictions, args.labels, 'caaga_role_coarse')
    if clean.empty:
        sys.exit("ERROR: no fully-resolved, matched rows to evaluate — fill in rater_labels.csv first.")

    table3, macro_f1 = score(clean['resolved_label'], clean['caaga_role_coarse'], ROLES)
    print_table(table3, f"Table 3. Semantic-Role Inference accuracy (n={len(clean)} columns)")
    print(f"\nmacro-F1 = {macro_f1:.2f}  <- this is the [X.XX] value referenced in the Abstract, "
          f"Section 5.2, Section 6.1, and the Conclusion.")

    other_stats = report_other_class(clean['resolved_label'], clean['caaga_role_coarse'])
    print(f"\n'other' (not one of the nine roles, reported separately, not part of the macro average): "
          f"n={other_stats['n']}, precision={other_stats['precision']:.2f}, "
          f"recall={other_stats['recall']:.2f}, F1={other_stats['f1']:.2f}")

    confusions = top_confusions(clean['resolved_label'], clean['caaga_role_coarse'], ROLES + [OTHER])
    if confusions:
        print("\nMost frequent confusions (true role -> CAAGA's predicted role):")
        for count, true_role, pred_role in confusions:
            print(f"  {true_role} -> {pred_role}: {count}")
    else:
        print("\nNo confusions among labeled columns — every resolved label matched CAAGA's prediction.")

    strongest = table3.iloc[:-1].loc[table3.iloc[:-1]['F1'].idxmax()]
    weakest = table3.iloc[:-1].loc[table3.iloc[:-1]['F1'].idxmin()]
    print(f"\nStrongest role: {strongest['Role']} (F1={strongest['F1']:.2f}, n={int(strongest['Columns (n)'])})")
    print(f"Weakest role:   {weakest['Role']} (F1={weakest['F1']:.2f}, n={int(weakest['Columns (n)'])})")

    table3.to_csv('table3_semantic_role_accuracy.csv', index=False, float_format='%.2f')
    with open('table3_semantic_role_accuracy.md', 'w') as f:
        f.write(table3.to_markdown(index=False, floatfmt='.2f'))
    print("\nWrote table3_semantic_role_accuracy.csv and .md — ready to paste into the manuscript.")

    if args.baseline:
        base_clean, _, _ = load_and_merge(args.baseline, args.labels, 'baseline_role')
        base_table, base_macro_f1 = score(base_clean['resolved_label'], base_clean['baseline_role'], ROLES)
        print_table(base_table, f"\nBaseline comparison (n={len(base_clean)} columns)")
        print(f"\nBaseline macro-F1 = {base_macro_f1:.2f}  (CAAGA macro-F1 = {macro_f1:.2f})")


if __name__ == '__main__':
    main()
