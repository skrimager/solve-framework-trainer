"""TTS sidecar — invoked as a subprocess from the Node server.

Usage: python3 tts.py "<text>" <voice> <output_path>
Writes MP3 bytes to output_path and prints nothing on success (exit code 0).
"""
import asyncio
import sys

from pplx.python.sdks.llm_api import (
    AudioGenParams,
    Client,
    Conversation,
    Identity,
    LLMAPIClient,
    MediaGenParams,
    SamplingParams,
)

TTS_OUTPUT_FORMAT = "mp3_44100_128"


async def generate_audio(text: str, voice: str = "kore", model: str = "gemini_2_5_pro_tts") -> bytes:
    client = LLMAPIClient()
    convo = Conversation()
    convo.set_single_audio_prompt(text)

    result = await client.messages.create(
        model=model,
        convo=convo,
        identity=Identity(client=Client.ASI, use_case="webserver_audio_gen"),
        sampling_params=SamplingParams(max_tokens=1),
        media_gen_params=MediaGenParams(
            audio=AudioGenParams(voice=voice, output_format=TTS_OUTPUT_FORMAT),
        ),
    )

    if not result.audios:
        raise RuntimeError("No audio generated")
    import base64
    return base64.b64decode(result.audios[0].b64_data)


async def main():
    text = sys.argv[1]
    voice = sys.argv[2] if len(sys.argv) > 2 else "kore"
    output_path = sys.argv[3]

    audio_bytes = await generate_audio(text, voice=voice)
    with open(output_path, "wb") as f:
        f.write(audio_bytes)


if __name__ == "__main__":
    asyncio.run(main())
