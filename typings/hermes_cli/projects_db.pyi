from dataclasses import dataclass
from sqlite3 import Connection

@dataclass
class ProjectFolder:
	path: str
	label: str | None
	is_primary: bool
	added_at: int

@dataclass
class Project:
	id: str
	archived: bool
	folders: list[ProjectFolder]

def connect() -> Connection: ...
def list_projects(conn: Connection, *, include_archived: bool = False) -> list[Project]: ...
def get_project(conn: Connection, id_or_slug: str) -> Project | None: ...
def create_project(conn: Connection, *, name: str, folders: list[str] | None = None) -> str: ...
def add_folder(
	conn: Connection,
	project_id: str,
	path: str,
	*,
	label: str | None = None,
	is_primary: bool = False,
) -> str: ...
def remove_folder(conn: Connection, project_id: str, path: str) -> bool: ...
