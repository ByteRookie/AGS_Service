import sys
import os
import ast

def check_syntax(file_path):
    with open(file_path, 'r') as f:
        try:
            ast.parse(f.read())
            print(f"✓ {file_path} syntax is valid")
            return True
        except SyntaxError as e:
            print(f"✗ {file_path} syntax error: {e}")
            return False

def main():
    base_path = "custom_components/ags_service"
    files = [
        "__init__.py",
        "ags_service.py",
        "config_flow.py",
        "media_player.py",
        "sensor.py",
        "switch.py"
    ]
    
    all_ok = True
    for f in files:
        path = os.path.join(base_path, f)
        if not check_syntax(path):
            all_ok = False
            
    if all_ok:
        print("\nAll core files passed syntax check.")
    else:
        print("\nSome files failed syntax check.")
        sys.exit(1)

if __name__ == "__main__":
    main()
