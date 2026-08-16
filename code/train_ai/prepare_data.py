import csv
import json
import os


CSV_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "Chapter Structure - metaphysics_detailed_breakdown.csv",
)
OUTPUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "qwen_dataset.jsonl")


def load_csv(path: str) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def build_outline(row: dict, rows_by_key: dict) -> str:
    system = row["System"]
    chapter_row = rows_by_key.get((system, row["Chapter"], row["Chapter"], ""))
    sub_row = rows_by_key.get(
        (system, row["Chapter"], row["Sub-Chapter"], "")
    )

    lines = [f"- Book: {system}"]
    if chapter_row:
        lines.append(f"- Chapter {row['Chapter']}: {chapter_row['Name']}")
    if sub_row:
        lines.append(f"  - {row['Sub-Chapter']}: {sub_row['Name']}")
    lines.append(f"    - {row['Sub-Sub-Chapter']}: {row['Name']}")
    lines.append(f"      - {row['Description']}")
    if row.get("Alternative Names"):
        lines.append(f"      - Also known as: {row['Alternative Names']}")
    return "\n".join(lines)


def create_dataset_from_csv(csv_path: str, output_file: str) -> None:
    rows = load_csv(csv_path)

    rows_by_key: dict[tuple, dict] = {}
    for r in rows:
        rows_by_key[
            (r["System"], r["Chapter"], r["Sub-Chapter"], r["Sub-Sub-Chapter"])
        ] = r

    leaf_rows = [r for r in rows if r["Sub-Sub-Chapter"].strip()]

    entries = []
    for row in leaf_rows:
        chapter_row = rows_by_key.get(
            (row["System"], row["Chapter"], row["Chapter"], "")
        )
        chapter_name = chapter_row["Name"] if chapter_row else row["System"]

        instruction = (
            f"Write 3 substantive, well-developed paragraphs about "
            f"\"{row['Name']}\" ({row['Description']}) "
            f"from chapter {row['Chapter']}, {chapter_name}, "
            f"in the book {row['System']}."
        )
        if row.get("Alternative Names"):
            instruction += f" Also known as: {row['Alternative Names']}."

        entries.append({
            "instruction": instruction,
            "input": build_outline(row, rows_by_key),
            "output": "",
        })

    with open(output_file, "w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry) + "\n")

    print(f"Generated {len(entries)} training entries from CSV → {output_file}")


if __name__ == "__main__":
    create_dataset_from_csv(CSV_FILE, OUTPUT_FILE)
