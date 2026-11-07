Put the first administrator's password in `admin_password.txt` in this folder (12+ characters, one line).

    openssl rand -base64 24 > secrets/admin_password.txt

It is read only on the very first start, when no administrator exists. You will be asked to choose a new
password at first sign-in. This folder is excluded from git and from the Docker build context.
