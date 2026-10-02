#!/usr/bin/env python3
"""
label_rater_cli.py — safe, no-Excel way for a rater to fill in
rater_labeling_template.csv (or a rater's own copy of it), one column
at a time, picking from a fixed numbered menu instead of typing free
text.

Why this exists: hand-editing the CSV in Excel (typing labels in, or
doing a find-and-replace across the sheet) has corrupted this file
before — once by rewriting text inside the column_name identifier
itself, and generally by drifting away from the controlled ten-value
vocabulary evaluate_semantic_role_inference.py requires. This script
only ever writes into ONE column (rater1_label or rater2_label,
whichever you pick with --rater) and never touches dataset_id /
file_type / column_name, so the row identity can't be damaged no
matter what you do.

Usage (from a terminal, with Python 3 installed — no extra packages
needed):

    python3 label_rater_cli.py rater_labeling_template.csv --rater 1

(use --rater 2 for the second rater's copy). Run it again any time to
pick up where you left off — rows you already labeled are skipped, so
it's safe to stop partway through and resume later.

Each prompt shows the dataset, the file/table, and the column name,
then asks you to type a number 1-10 for the role that best fits. Type
's' to skip a row and come back to it later, or 'q' to save and quit.
"""
import argparse
import csv
import sys

VALID_LABELS = [
    'Identifier',
    'Date/time',
    'Monetary amount',
    'Quantity',
    'Category',
    'Rating',
    'Geography',
    'Status',
    'Free text',
    'other',
]

FIELDNAMES = ['dataset_id', 'dataset_name', 'file_type', 'column_name',
              'rater1_label', 'rater2_label', 'resolved_label']


def load_rows(path):
    with open(path, newline='', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    return rows


def save_rows(path, rows):
    with open(path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        for r in rows:
            writer.writerow({k: r.get(k, '') for k in FIELDNAMES})


def print_menu():
    print()
    for i, label in enumerate(VALID_LABELS, start=1):
        print(f"  {i}. {label}")
    print("  s. skip this row for now")
    print("  q. save and quit")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('csv_path', help='Path to your copy of rater_labeling_template.csv')
    ap.add_argument('--rater', required=True, choices=['1', '2'],
                     help='Which rater column you are filling: 1 or 2')
    args = ap.parse_args()

    col = f'rater{args.rater}_label'
    rows = load_rows(args.csv_path)

    if not rows:
        print(f"'{args.csv_path}' has no data rows — nothing to label. "
              f"Check that the template was generated correctly.")
        sys.exit(1)

    total = len(rows)
    remaining = [r for r in rows if not (r.get(col) or '').strip()]
    print(f"{total} columns total, {len(remaining)} still need a rater {args.rater} label.")
    print("Pick a number for each — type 's' to skip, 'q' to save and quit.")

    done_count = total - len(remaining)
    for row in rows:
        if (row.get(col) or '').strip():
            continue  # already labeled — resume support

        print("-" * 60)
        print(f"Dataset:  {row['dataset_id']}  ({row['dataset_name']})")
        print(f"File:     {row['file_type']}")
        print(f"Column:   {row['column_name']}")
        print_menu()

        while True:
            choice = input(f"\n[{done_count + 1}/{total}] Your choice: ").strip().lower()
            if choice == 'q':
                save_rows(args.csv_path, rows)
                print(f"\nSaved. {done_count} of {total} labeled so far — run again to continue.")
                sys.exit(0)
            if choice == 's':
                break
            if choice.isdigit() and 1 <= int(choice) <= len(VALID_LABELS):
                row[col] = VALID_LABELS[int(choice) - 1]
                done_count += 1
                break
            print("Not a valid choice — type a number from the list, 's', or 'q'.")

        # Save after every row so nothing is lost if the terminal closes.
        save_rows(args.csv_path, rows)

    print(f"\nAll rows labeled. File saved: {args.csv_path}")


if __name__ == '__main__':
    main()
