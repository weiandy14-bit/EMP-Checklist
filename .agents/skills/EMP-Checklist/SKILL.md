```markdown
# EMP-Checklist Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the EMP-Checklist Python repository. It covers file organization, code style, commit practices, and testing patterns to help contributors maintain consistency and quality in the codebase.

## Coding Conventions

### File Naming
- Use **snake_case** for all Python file names.
  - Example: `employee_checklist.py`, `user_utils.py`

### Import Style
- Use **relative imports** within the package.
  - Example:
    ```python
    from .utils import check_permissions
    from .models import Employee
    ```

### Export Style
- Use **named exports** (explicitly listing what is exported from a module).
  - Example:
    ```python
    __all__ = ['EmployeeChecklist', 'ChecklistItem']
    ```

### Commit Message Patterns
- Prefix commits with type, such as `security` or `chore`.
- Keep commit messages concise (average ~53 characters).
  - Example:  
    ```
    security: fix permission check in checklist creation
    chore: update dependencies for Python 3.10 compatibility
    ```

## Workflows

### Code Contribution
**Trigger:** When adding or modifying features or fixing bugs  
**Command:** `/contribute`

1. Create a new branch for your feature or fix.
2. Follow coding conventions for file naming and imports.
3. Write or update tests as needed.
4. Commit changes using the appropriate prefix (`security`, `chore`, etc.).
5. Push your branch and open a pull request.

### Dependency Update
**Trigger:** When updating or adding dependencies  
**Command:** `/update-deps`

1. Update the relevant dependency files (e.g., `requirements.txt`).
2. Test the application to ensure compatibility.
3. Commit with the `chore` prefix.
4. Push changes and create a pull request.

## Testing Patterns

- Test files follow the `*.test.*` naming pattern.
  - Example: `employee_checklist.test.py`
- Testing framework is **unknown**; check existing test files for patterns.
- Place tests alongside or near the modules they test.
- Example test file structure:
  ```python
  import unittest
  from .employee_checklist import EmployeeChecklist

  class TestEmployeeChecklist(unittest.TestCase):
      def test_add_item(self):
          checklist = EmployeeChecklist()
          checklist.add_item("Submit ID")
          self.assertIn("Submit ID", checklist.items)
  ```

## Commands
| Command        | Purpose                                    |
|----------------|--------------------------------------------|
| /contribute    | Start the code contribution workflow        |
| /update-deps   | Update dependencies and related files       |
```