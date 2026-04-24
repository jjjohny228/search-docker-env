FROM docker:28-cli

RUN apk add --no-cache python3 py3-pip py3-virtualenv

WORKDIR /app

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

CMD ["python3", "docker_hub_env_finder.py", "--help"]
