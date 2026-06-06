from __future__ import annotations

from typing import cast

from robomp.github_backend import GitHubBackend
from robomp.github_client import IssueInfo
from robomp.tasks import _attach_thread
from robomp.worker import DirectiveInfo


class _ThreadGithub:
    async def get_issue(self, repo: str, number: int) -> IssueInfo:
        assert repo == "octo/widget"
        assert number == 9
        return IssueInfo(
            repo=repo,
            number=number,
            title="Title",
            body="Issue body",
            author="alice",
            state="open",
            labels=(),
            is_pull_request=False,
        )

    async def list_comments(self, repo: str, number: int) -> list[object]:
        assert repo == "octo/widget"
        assert number == 9
        return []


async def test_attach_thread_preserves_impl_authorization() -> None:
    directive = DirectiveInfo(body="Create a pr bro", author="can1357", authorizes_impl=True)
    github = cast(GitHubBackend, _ThreadGithub())

    hydrated = await _attach_thread(github, directive, "octo/widget", 9, is_pr=False)

    assert hydrated is not None
    assert hydrated.authorizes_impl is True
    assert hydrated.thread[0].body == "Issue body"
