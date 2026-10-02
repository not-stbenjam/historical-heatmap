"""Publish committed web assets to the project's GitHub Pages branch."""
import subprocess

REPOSITORY = "not-stbenjam/historical-heatmap"


def git(*args, input=None):
    return subprocess.check_output(["git", *args], input=input).decode().strip()


def network_git(*args):
    # Use the active gh account without writing its token into the remote URL.
    return git("-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", *args)


def verify_remote():
    print(git("remote", "-v"), flush=True)
    remote = git("remote", "get-url", "--push", "origin")
    allowed = {f"https://github.com/{REPOSITORY}.git", f"git@github.com:{REPOSITORY}.git"}
    if remote not in allowed:
        raise SystemExit(f"Refusing to publish to unexpected origin: {remote}")


def main():
    verify_remote()
    if git("status", "--porcelain"):
        raise SystemExit("Commit all source and generated website changes before publishing.")
    tree = git("rev-parse", "main:web")
    verify_remote()
    network_git("push", "-u", "origin", "main")
    # Keep deployment history and let an ordinary push reject concurrent updates.
    previous = network_git("ls-remote", "--heads", "origin", "gh-pages")
    parents = []
    if previous:
        network_git("fetch", "origin", "gh-pages")
        parents = ["-p", git("rev-parse", "FETCH_HEAD")]
    commit = git("commit-tree", tree, *parents, input=b"Publish historical heatmap\n\nAssisted-by: AI\n")
    verify_remote()
    network_git("push", "origin", f"{commit}:refs/heads/gh-pages")
    print("Published website branch: https://not-stbenjam.github.io/historical-heatmap/")


if __name__ == "__main__":
    main()
