# External SPL onboarding project

This folder is a template versioned with VariaMosPLE. The tests copy it to an independent temporary Git repository, create a commit, and connect that repository through the same public API used by the interface.

In a real project, the content lives in its own repository and only needs to version `.variamos/spl.json`. The relationship between features and artifacts is confirmed later in VariaMos; this repository does not attempt to infer it.
