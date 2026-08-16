import os
import subprocess
import sys

from charset_normalizer import from_path

SANITIZATION_MAP = str.maketrans({
    '\u201c': '"',  # "
    '\u201d': '"',  # "
    '\u2018': "'",  # '
    '\u2019': "'",  # '
    '\u2014': '-',   # —
    '\u2013': '-',   # –
    '\u2026': '...', # …
})

def find_files(path):
    """
    Traverses through the given path recursively to find all file extensions,
    and lists files whose extensions are not blank or .txt.
    """
    for root, dirs, files in os.walk(path):
        for file in files:
            _, extension = os.path.splitext(file)
            extension = extension.lower()
            if extension not in ['', '.txt', '.md']:
                print(os.path.join(root, file))

def combine_text_files(path, output_filename="combined_output.txt"):
    """
    Finds all files with .txt, .md, or no extension and combines them into a single file.
    Each file's content is preceded by its original file path.
    """
    with open(output_filename, 'w', encoding='utf-8') as outfile:
        for root, dirs, files in os.walk(path):
            for file in files:
                _, extension = os.path.splitext(file)
                if extension.lower() in ['.txt', '.md', '']:
                    filepath = os.path.join(root, file)
                    try:
                        with open(filepath, 'r', encoding='utf-8', errors='ignore') as infile:
                            outfile.write(f"--- {filepath} ---\n\n")
                            outfile.write(infile.read())
                            outfile.write("\n\n")
                    except Exception as e:
                        print(f"Error reading file {filepath}: {e}")
    print(f"All specified files have been combined into '{output_filename}'")

def find_empty_dirs(path):
    """
    Traverses through the given path recursively and returns a list of
    all empty directories (directories containing no files or subdirectories),
    including hidden and system files in the check.
    """
    empty_dirs = []
    for root, dirs, files in os.walk(path, topdown=False):
        try:
            if not any(os.scandir(root)):
                empty_dirs.append(root)
        except PermissionError:
            pass
    return empty_dirs


def find_whitespace_files(path):
    """
    Traverses through the given path recursively and returns a list of
    files whose content is empty or contains only whitespace.
    """
    whitespace_files = []
    for root, dirs, files in os.walk(path):
        for file in files:
            filepath = os.path.join(root, file)
            try:
                if os.path.getsize(filepath) >= 1024:
                    continue
                with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                    if not f.read().strip():
                        whitespace_files.append(filepath)
            except Exception:
                pass
    return whitespace_files


def find_non_utf8_files(path):
    """
    Traverses through the given path recursively and returns a list of
    (filepath, detected_encoding) tuples for files that are not clean UTF-8.
    Detects UTF-8 BOM directly from bytes, then attempts a strict UTF-8 decode
    to catch any other non-UTF-8 files.
    """
    non_utf8 = []
    for root, dirs, files in os.walk(path):
        for file in files:
            filepath = os.path.join(root, file)
            try:
                with open(filepath, 'rb') as f:
                    raw = f.read()
                if not raw:
                    continue
                # UTF-8 BOM is a clear indicator of utf-8-sig
                if raw.startswith(b'\xef\xbb\xbf'):
                    non_utf8.append((filepath, 'utf-8-sig'))
                    continue
                # Strict UTF-8 decode catches everything else (latin-1, utf-7, windows-1252, etc.)
                try:
                    raw.decode('utf-8')
                except UnicodeDecodeError:
                    match = from_path(filepath).best()
                    encoding = match.encoding if match else 'unknown'
                    non_utf8.append((filepath, encoding))
            except Exception:
                pass
    return non_utf8


def convert_to_utf8(file_paths):
    """
    Re-encodes each file in file_paths to UTF-8, applying typographic
    character sanitization (smart quotes, em-dashes, ellipses, etc.).
    UTF-8 BOM files are handled by stripping the BOM directly.
    """
    skipped = []
    for filepath in file_paths:
        try:
            with open(filepath, 'rb') as f:
                raw = f.read()
            if raw.startswith(b'\xef\xbb\xbf'):
                text = raw[3:].decode('utf-8')
            else:
                match = from_path(filepath).best()
                if not match:
                    print(f"  Could not determine encoding: {filepath}")
                    skipped.append(filepath)
                    continue
                text = str(match)
            sanitized = text.translate(SANITIZATION_MAP)
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(sanitized)
            print(f"  Converted: {filepath}")
        except Exception as e:
            print(f"  Error converting '{filepath}': {e}")
            skipped.append(filepath)
    if skipped:
        print(f"\n{len(skipped)} file(s) could not be converted.")


def delete_files(file_paths):
    """
    Deletes each file in the given list.
    """
    for filepath in file_paths:
        try:
            os.remove(filepath)
            print(f"Deleted: {filepath}")
        except Exception as e:
            print(f"Error deleting '{filepath}': {e}")


def delete_empty_dirs(empty_dirs):
    """
    Deletes each directory in the given list of empty directories.
    Falls back to the Windows shell rmdir command for directories
    that are blocked by Google Drive or other virtual filesystems.
    """
    for dir_path in empty_dirs:
        try:
            os.rmdir(dir_path)
            print(f"Deleted: {dir_path}")
        except PermissionError:
            try:
                result = subprocess.run(
                    ['cmd', '/c', 'rmdir', '/s', '/q', dir_path],
                    capture_output=True, text=True
                )
                if result.returncode == 0:
                    print(f"Deleted: {dir_path}")
                else:
                    print(f"Error deleting '{dir_path}': {result.stderr.strip()}")
            except Exception as e:
                print(f"Error deleting '{dir_path}': {e}")
        except Exception as e:
            print(f"Error deleting '{dir_path}': {e}")


if __name__ == "__main__":
    # You can replace this path with the one you want to analyze.
    # Or, you can pass it as a command-line argument.
    if len(sys.argv) > 1:
        start_path = sys.argv[1]
    else:
        # Default path if no argument is given
        start_path = 'C:\\Users\\snowb\\My Drive\\writing'

    if not os.path.isdir(start_path):
        print(f"Error: The path '{start_path}' is not a valid directory.")
        sys.exit(1)

    # find_files(start_path)
    # combine_text_files(start_path)

    # empty = find_empty_dirs(start_path)
    # if not empty:
    #     print("No empty directories found.")
    # else:
    #     print("\nEmpty directories found:")
    #     for d in empty:
    #         print(f"  {d}")
    #     answer = input("\nDelete these empty directories? [y/N] ").strip().lower()
    #     if answer == 'y':
    #         delete_empty_dirs(empty)
    #     else:
    #         print("Skipped deletion.")

    # whitespace = find_whitespace_files(start_path)
    # if not whitespace:
    #     print("No whitespace-only files found.")
    # else:
    #     print("\nWhitespace-only files found:")
    #     for f in whitespace:
    #         print(f"  {f}")
    #     answer = input("\nDelete these files? [y/N] ").strip().lower()
    #     if answer == 'y':
    #         delete_files(whitespace)
    #     else:
    #         print("Skipped deletion.")

    non_utf8 = find_non_utf8_files(start_path)
    if not non_utf8:
        print("All files are UTF-8 or ASCII.")
    else:
        print("\nNon-UTF-8 files found:")
        for filepath, encoding in non_utf8:
            print(f"  [{encoding}]  {filepath}")

        encoding_counts = {}
        for _, encoding in non_utf8:
            encoding_counts[encoding] = encoding_counts.get(encoding, 0) + 1
        print("\nEncoding summary:")
        for encoding, count in sorted(encoding_counts.items(), key=lambda x: -x[1]):
            print(f"  {encoding}: {count} file(s)")
        print(f"  Total: {len(non_utf8)} file(s)")

        answer = input("\nConvert these files to UTF-8? [y/N] ").strip().lower()
        if answer == 'y':
            convert_to_utf8([fp for fp, _ in non_utf8])
        else:
            print("Skipped conversion.")

    



