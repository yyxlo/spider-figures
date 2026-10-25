from django.db import migrations

DEFAULT_STRUCTURES = [
    ("整體外觀", "habitus", 10),
    ("頭胸部與眼區", "prosoma / eye region", 20),
    ("螯肢", "chelicerae", 30),
    ("步足", "legs", 40),
    ("腹部", "opisthosoma", 50),
    ("紡器", "spinnerets", 60),
    ("雄觸肢", "male palp", 70),
    ("觸肢器細部", "palpal sclerites", 80),
    ("雌外生殖器", "epigyne", 90),
    ("雌內生殖器", "vulva", 100),
    ("其他", "other", 900),
]


def enable_trigram(apps, schema_editor):
    if schema_editor.connection.vendor == "postgresql":
        schema_editor.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")


def add_structures(apps, schema_editor):
    Structure = apps.get_model("catalog", "Structure")
    for name, name_en, order in DEFAULT_STRUCTURES:
        Structure.objects.get_or_create(name=name, defaults={"name_en": name_en, "order": order})


class Migration(migrations.Migration):
    dependencies = [("catalog", "0001_initial")]

    operations = [
        migrations.RunPython(enable_trigram, migrations.RunPython.noop),
        migrations.RunPython(add_structures, migrations.RunPython.noop),
    ]
